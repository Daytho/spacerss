import { initScene, setupPlanetClicks } from './scene.js';
import {
  createPlanet, updatePlanetTransform, updatePlanetAppearance, assignFieldSlots, rotationToFace,
  disposePlanet,
} from './planet.js';
import { createLabelLayer } from './labels.js';

const MOBILE_BREAKPOINT = 768;
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

const container = document.getElementById('scene-container');
const {
  camera, renderer, field, onUpdate,
} = initScene(container);
const labels = createLabelLayer(container);

const planetGroups = new Map(); // article id -> THREE.Group
let currentFilter = 'all';
let hasOriented = false;

const statusLine = document.getElementById('status-line');
const loadingMsg = document.getElementById('loading-msg');

// How many planets go in the field.
//
// A wide monitor used to be served the same 20 as a laptop. The horizontal
// field of view is held constant, so those extra pixels went to empty space
// between the same few planets rather than to more news: measured at
// 3440x1440, only 3 of the 20 were on screen at once. Scaling the count with
// width fills the frame with articles instead of with black.
const SLOT_STEPS = [
  { upTo: MOBILE_BREAKPOINT, slots: 10 },
  { upTo: 1100, slots: 18 },
  { upTo: 1600, slots: 24 },
  { upTo: 2200, slots: 30 },
  { upTo: Infinity, slots: 38 },
];

function slotsForViewport() {
  const w = window.innerWidth;
  return SLOT_STEPS.find((step) => w < step.upTo).slots;
}

let currentSlots = slotsForViewport();

function matchesCurrentFilter(article) {
  if (currentFilter === 'all') return true;
  return article.categories.split(',').includes(currentFilter);
}

async function fetchArticles() {
  const res = await fetch(`/api/articles?slots=${slotsForViewport()}&filter=${currentFilter}`);
  if (!res.ok) throw new Error(`GET /api/articles failed: ${res.status}`);
  return res.json();
}

function disposeGroup(group) {
  field.remove(group);
  disposePlanet(group);
}

function renderArticles(articles) {
  const seen = new Set();

  for (const article of articles) {
    seen.add(article.id);
    const existing = planetGroups.get(article.id);

    if (existing) {
      const prev = existing.userData.article;
      const rebuild = Boolean(prev.pinned) !== Boolean(article.pinned)
        || prev.severity_tier !== article.severity_tier
        || prev.blast_radius !== article.blast_radius;

      if (!rebuild) {
        // Cheap in-place refresh: text and flags only, geometry untouched.
        existing.userData.article = article;
        existing.userData.mesh.userData.article = article;
        continue;
      }
      disposeGroup(existing);
      planetGroups.delete(article.id);
      labels.remove(article.id);
    }

    const group = createPlanet(article);
    field.add(group);
    planetGroups.set(article.id, group);
  }

  for (const [id, group] of planetGroups) {
    if (!seen.has(id)) {
      disposeGroup(group);
      planetGroups.delete(id);
      labels.remove(id);
    }
  }

  assignFieldSlots(planetGroups.values(), slotsForViewport());

  // On the first load, turn the field so the most severe story is the one in
  // front of the viewer instead of an arbitrary slot.
  if (!hasOriented && planetGroups.size > 0) {
    const worst = [...planetGroups.values()].reduce((a, b) => (
      (b.userData.article.severity_score ?? 0) > (a.userData.article.severity_score ?? 0) ? b : a
    ));
    field.rotation.y = rotationToFace(worst);
    hasOriented = true;
  }

  if (loadingMsg) loadingMsg.remove();
  if (statusLine) {
    const stated = articles.filter((a) => a.impact_stated).length;
    statusLine.textContent = `${articles.length} tracked · ${stated} with reported impact · `
      + `updated ${new Date().toLocaleTimeString()}`;
  }
}

async function refreshArticles() {
  try {
    renderArticles(await fetchArticles());
  } catch (err) {
    console.error('[main] failed to refresh articles:', err);
    if (statusLine) statusLine.textContent = 'Failed to load articles';
  }
}

onUpdate((dt, elapsed) => {
  for (const group of planetGroups.values()) {
    updatePlanetTransform(group, elapsed, dt);
    updatePlanetAppearance(group, matchesCurrentFilter(group.userData.article));
  }
  labels.update(planetGroups.values(), camera, renderer, matchesCurrentFilter);
});

setupPlanetClicks(
  renderer,
  camera,
  () => Array.from(planetGroups.values(), (g) => g.userData.mesh),
  (mesh) => openInfoPanel(mesh.userData.article),
);

// --- Filter bar ---
const filterButtons = document.querySelectorAll('.filter-bar button');
filterButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    currentFilter = btn.dataset.filter;
    filterButtons.forEach((b) => b.classList.toggle('active', b === btn));
  });
});

// --- Manual refresh ---
//
// Pinned planets are untouched by this: /api/articles always includes every
// pinned article regardless of what ingest finds, and renderArticles() only
// rebuilds a planet's geometry when its pinned state, tier or blast radius
// actually changed, so a pinned planet just gets its data pointer refreshed
// in place. Only the unpinned slots reshuffle with whatever is new.
const refreshBtn = document.getElementById('refresh-btn');
let refreshInFlight = false;

async function manualRefresh() {
  if (refreshInFlight) return;
  refreshInFlight = true;
  refreshBtn.disabled = true;
  refreshBtn.classList.add('spinning');

  try {
    const res = await fetch('/api/refresh', { method: 'POST' });
    if (!res.ok) throw new Error(`POST /api/refresh failed: ${res.status}`);
    const { inserted } = await res.json();
    await refreshArticles();
    if (statusLine && inserted > 0) {
      statusLine.textContent = `${inserted} new · ${statusLine.textContent}`;
    }
  } catch (err) {
    console.error('[main] manual refresh failed:', err);
    if (statusLine) statusLine.textContent = 'Refresh failed — try again';
  } finally {
    refreshBtn.disabled = false;
    refreshBtn.classList.remove('spinning');
    refreshInFlight = false;
  }
}

refreshBtn.addEventListener('click', manualRefresh);

// --- Breakpoint watcher ---
// Refetch only when the viewport crosses into a different slot budget, not on
// every resize event.
window.addEventListener('resize', () => {
  const next = slotsForViewport();
  if (next !== currentSlots) {
    currentSlots = next;
    refreshArticles();
    return;
  }
  // Same slot budget, so no refetch is needed — but how far the field spreads
  // above and below the viewer is derived from the viewport's aspect ratio,
  // which has just changed. Without this the spread stays stale until the next
  // refresh, up to five minutes later.
  assignFieldSlots(planetGroups.values(), currentSlots);
});

// --- Info panel ---
const infoPanel = document.getElementById('info-panel');
const infoSource = document.getElementById('info-source');
const infoTitle = document.getElementById('info-title');
const infoCategories = document.getElementById('info-categories');
const infoImpact = document.getElementById('info-impact');
const infoSummary = document.getElementById('info-summary');
const infoLink = document.getElementById('info-link');
const pinBtn = document.getElementById('pin-btn');
const saveBtn = document.getElementById('save-btn');
const closeBtn = document.getElementById('info-close');
const infoBackdrop = document.getElementById('info-backdrop');

let currentArticle = null;
const inFlight = new Set();

function paintActionButtons(article) {
  pinBtn.classList.toggle('active', Boolean(article.pinned));
  pinBtn.textContent = article.pinned ? 'Pinned' : 'Pin';
  saveBtn.classList.toggle('active', Boolean(article.saved));
  saveBtn.textContent = article.saved ? 'Saved' : 'Save';
}

const SEVERITY_WORD = {
  5: 'Critical', 4: 'High', 3: 'Moderate', 2: 'Low', 1: 'Info',
};

function openInfoPanel(article) {
  currentArticle = article;
  infoSource.textContent = `${article.source} · ${new Date(article.published_at).toLocaleString()}`;
  infoTitle.textContent = article.title;

  infoCategories.innerHTML = '';
  const sev = document.createElement('span');
  sev.className = `badge severity tier-${article.severity_tier}`;
  sev.textContent = SEVERITY_WORD[article.severity_tier] || 'Info';
  infoCategories.appendChild(sev);

  article.categories.split(',').forEach((cat) => {
    const span = document.createElement('span');
    span.className = 'badge';
    span.textContent = cat;
    infoCategories.appendChild(span);
  });

  if (article.also_reported_by && article.also_reported_by.length > 0) {
    const span = document.createElement('span');
    span.className = 'badge corroborated';
    span.textContent = `+${article.also_reported_by.length} sources`;
    span.title = `Also reported by: ${article.also_reported_by.join(', ')}`;
    infoCategories.appendChild(span);
  }

  // Reach line: what drives this planet's size.
  infoImpact.textContent = article.impact_stated
    ? `Reported impact: ${article.label_fact}`
    : `Estimated reach — ${article.label_fact}`;
  infoImpact.classList.toggle('estimated', !article.impact_stated);

  infoSummary.textContent = article.summary || 'No summary available.';
  infoLink.href = article.link;
  paintActionButtons(article);
  infoPanel.classList.add('open');
  infoBackdrop.classList.add('open');
}

function closeInfoPanel() {
  infoPanel.classList.remove('open');
  infoBackdrop.classList.remove('open');
}

closeBtn.addEventListener('click', closeInfoPanel);
// The backdrop covers the scene whenever the panel is open, so any click that
// reaches it is by definition a click outside the panel.
infoBackdrop.addEventListener('click', closeInfoPanel);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && infoPanel.classList.contains('open')) closeInfoPanel();
});

/**
 * Toggle pin/save with an optimistic update: repaint the button immediately so
 * the click registers on the next frame instead of waiting on the round trip,
 * then reconcile with the server's response (rolling back if it failed). The
 * in-flight guard stops a double-click from firing two toggles that race.
 */
async function toggleField(fieldName) {
  if (!currentArticle) return;
  const article = currentArticle;
  const key = `${article.id}:${fieldName}`;
  if (inFlight.has(key)) return;
  inFlight.add(key);

  const prop = fieldName === 'pin' ? 'pinned' : 'saved';
  const optimistic = { ...article, [prop]: article[prop] ? 0 : 1 };
  currentArticle = optimistic;
  paintActionButtons(optimistic);

  try {
    const res = await fetch(`/api/articles/${article.id}/${fieldName}`, { method: 'POST' });
    if (!res.ok) throw new Error(`toggle ${fieldName} failed: ${res.status}`);
    const updated = await res.json();
    if (currentArticle && currentArticle.id === updated.id) {
      currentArticle = updated;
      paintActionButtons(updated);
    }
    refreshArticles();
  } catch (err) {
    console.error('[main]', err);
    if (currentArticle && currentArticle.id === article.id) {
      currentArticle = article;
      paintActionButtons(article);
    }
  } finally {
    inFlight.delete(key);
  }
}

pinBtn.addEventListener('click', () => toggleField('pin'));
saveBtn.addEventListener('click', () => toggleField('save'));

refreshArticles();
setInterval(refreshArticles, REFRESH_INTERVAL_MS);
