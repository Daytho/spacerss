import * as THREE from '/vendor/three/build/three.module.js';
import { distanceScale } from './planet.js';

/**
 * Proximity labels.
 *
 * A planet states its business as it drifts near the viewer: a two-line summary
 * that fades in with proximity and fades out again as it recedes. Line one is
 * category and severity, line two is the strongest concrete fact the article
 * offers — an affected count where one was reported ("9.5M patients affected",
 * "25GB of data stolen"), otherwise exploitation status or CVSS.
 *
 * Labels are HTML positioned over the canvas rather than 3D sprites, so the text
 * stays crisp at any distance and inherits the page's typography.
 */

// Distance at which a label is fully readable, and where it has faded out.
// Scaled with the field itself, which is drawn closer on small screens.
const NEAR_LIMIT = 80;
const FAR_LIMIT = 165;
// Never show more than this many at once, however crowded the field gets. A
// phone has far less room, so it shows fewer.
function maxVisible() {
  return window.innerWidth < 768 ? 3 : 7;
}
// Room reserved for the chrome at each end of the frame: the brand and filter
// bar at the top, the status line and legend at the bottom.
const BOTTOM_SAFE_AREA = 56;
const TOP_SAFE_AREA = 66;

const TIER_CLASS = {
  5: 'tier-5', 4: 'tier-4', 3: 'tier-3', 2: 'tier-2', 1: 'tier-1',
};

export function createLabelLayer(container) {
  const layer = document.createElement('div');
  layer.className = 'label-layer';
  container.appendChild(layer);

  const entries = new Map(); // article id -> { el, headline, fact }
  const worldPos = new THREE.Vector3();
  const projected = new THREE.Vector3();
  const cameraDir = new THREE.Vector3();

  function ensureEntry(article) {
    let entry = entries.get(article.id);
    if (entry) return entry;

    const el = document.createElement('div');
    el.className = `planet-label ${TIER_CLASS[article.severity_tier] || 'tier-1'}`;

    const headline = document.createElement('span');
    headline.className = 'label-headline';
    headline.textContent = article.label_headline || '';

    const fact = document.createElement('span');
    fact.className = 'label-fact';
    fact.textContent = article.label_fact || '';

    el.append(headline, fact);
    layer.appendChild(el);

    entry = { el, headline, fact };
    entries.set(article.id, entry);
    return entry;
  }

  /**
   * @param groups   live planet groups
   * @param camera   scene camera
   * @param renderer used for canvas dimensions
   * @param isVisible predicate — a planet dimmed by the filter gets no label
   */
  function update(groups, camera, renderer, isVisible = () => true) {
    const rect = renderer.domElement.getBoundingClientRect();
    camera.getWorldDirection(cameraDir);

    const scale = distanceScale();
    const nearLimit = NEAR_LIMIT * scale;
    const farLimit = FAR_LIMIT * scale;

    const candidates = [];

    for (const group of groups) {
      const { article } = group.userData;
      if (!isVisible(article)) continue;

      group.getWorldPosition(worldPos);
      const distance = worldPos.length(); // camera sits at the origin

      if (distance > farLimit) continue;
      // Skip anything behind the viewer.
      if (worldPos.dot(cameraDir) <= 0) continue;

      projected.copy(worldPos).project(camera);
      if (projected.x < -1.05 || projected.x > 1.05 || projected.y < -1.05 || projected.y > 1.05) {
        continue;
      }

      const proximity = 1 - Math.max(0, Math.min(1,
        (distance - nearLimit) / (farLimit - nearLimit)));

      candidates.push({
        group,
        article,
        distance,
        opacity: 0.15 + proximity * 0.85,
        x: (projected.x * 0.5 + 0.5) * rect.width,
        y: (-projected.y * 0.5 + 0.5) * rect.height,
        radius: group.userData.radius,
      });
    }

    // Nearest first, so the closest planets win the limited label slots.
    candidates.sort((a, b) => a.distance - b.distance);
    const shown = candidates.slice(0, maxVisible());
    const shownIds = new Set(shown.map((c) => c.article.id));

    for (const c of shown) {
      const entry = ensureEntry(c.article);
      if (entry.headline.textContent !== (c.article.label_headline || '')) {
        entry.headline.textContent = c.article.label_headline || '';
      }
      if (entry.fact.textContent !== (c.article.label_fact || '')) {
        entry.fact.textContent = c.article.label_fact || '';
      }

      // Offset below the planet, scaled by its on-screen size so the label
      // clears large planets without floating away from small ones.
      const screenScale = (rect.height / (2 * Math.tan((camera.fov * Math.PI) / 360)));
      const pixelRadius = (c.radius / c.distance) * screenScale;
      const offset = Math.min(90, pixelRadius + 12);

      // Keep the box inside the viewport. A label that runs off the edge or
      // slides under the status bar is worse than one sitting slightly off its
      // planet, so clamp rather than letting it clip.
      const halfWidth = (entry.el.offsetWidth || 150) / 2;
      const height = entry.el.offsetHeight || 34;
      const x = Math.max(halfWidth + 8, Math.min(rect.width - halfWidth - 8, c.x));
      const y = Math.max(
        TOP_SAFE_AREA,
        Math.min(rect.height - height - BOTTOM_SAFE_AREA, c.y + offset),
      );

      entry.el.style.transform = `translate(-50%, 0) translate(${x}px, ${y}px)`;
      entry.el.style.opacity = c.opacity.toFixed(3);
      entry.el.classList.add('visible');
    }

    for (const [id, entry] of entries) {
      if (!shownIds.has(id)) {
        entry.el.classList.remove('visible');
        entry.el.style.opacity = '0';
      }
    }
  }

  function remove(id) {
    const entry = entries.get(id);
    if (entry) {
      entry.el.remove();
      entries.delete(id);
    }
  }

  function clear() {
    for (const entry of entries.values()) entry.el.remove();
    entries.clear();
  }

  return { update, remove, clear };
}
