import { initScene, setupPlanetClicks } from './scene.js';
import {
  createPlanet, updatePlanetTransform, updatePlanetAppearance, assignFieldSlots, disposePlanet,
} from './planet.js';
import { createLabelLayer } from './labels.js';

const container = document.getElementById('scene-container');
const {
  camera, renderer, field, onUpdate,
} = initScene(container);
const labels = createLabelLayer(container);

const planetGroups = new Map();
const statusLine = document.getElementById('status-line');
const loadingMsg = document.getElementById('loading-msg');

async function fetchSaved() {
  const res = await fetch('/api/saved');
  if (!res.ok) throw new Error(`GET /api/saved failed: ${res.status}`);
  return res.json();
}

function disposeGroup(group) {
  field.remove(group);
  disposePlanet(group);
}

function renderArticles(articles) {
  for (const group of planetGroups.values()) disposeGroup(group);
  planetGroups.clear();
  labels.clear();

  for (const article of articles) {
    const group = createPlanet(article, { showPinRing: false });
    field.add(group);
    planetGroups.set(article.id, group);
  }

  assignFieldSlots(planetGroups.values(), planetGroups.size);

  if (loadingMsg) loadingMsg.remove();
  if (statusLine) {
    statusLine.textContent = articles.length > 0
      ? `${articles.length} saved`
      : 'No saved articles yet';
  }
}

async function refresh() {
  try {
    renderArticles(await fetchSaved());
  } catch (err) {
    console.error('[saved] failed to load saved articles:', err);
    if (statusLine) statusLine.textContent = 'Failed to load saved articles';
  }
}

onUpdate((dt, elapsed) => {
  for (const group of planetGroups.values()) {
    updatePlanetTransform(group, elapsed, dt, { distanceMode: 'tier' });
    updatePlanetAppearance(group, true, { fadeEnabled: false });
  }
  labels.update(planetGroups.values(), camera, renderer);
});

setupPlanetClicks(
  renderer,
  camera,
  () => Array.from(planetGroups.values(), (g) => g.userData.mesh),
  (mesh) => openInfoPanel(mesh.userData.article),
);

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

const SEVERITY_WORD = {
  5: 'Critical', 4: 'High', 3: 'Moderate', 2: 'Low', 1: 'Info',
};

function paintActionButtons(article) {
  pinBtn.classList.toggle('active', Boolean(article.pinned));
  pinBtn.textContent = article.pinned ? 'Pinned' : 'Pin';
  saveBtn.classList.toggle('active', Boolean(article.saved));
  saveBtn.textContent = article.saved ? 'Saved' : 'Save';
}

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

// Optimistic toggle — see the note in main.js.
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
    // Un-saving from this page removes the planet, so close the panel with it.
    if (fieldName === 'save' && !updated.saved) closeInfoPanel();
    refresh();
  } catch (err) {
    console.error('[saved]', err);
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

refresh();
