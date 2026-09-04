import * as THREE from '/vendor/three/build/three.module.js';

/**
 * Two independent visual channels:
 *
 *   COLOUR = severity tier   — how dangerous (critical red -> orange -> yellow
 *                              -> blue-grey -> dim grey)
 *   SIZE   = blast radius    — how far it reaches (people, organizations,
 *                              machines, money or data affected)
 *
 * They are deliberately decoupled: a critical flaw in niche industrial gear is a
 * small red planet, while a low-severity leak of 153 million records is a large
 * dim one.
 */

const TIER_COLOR = {
  5: 0xe0473f, // critical  — red
  4: 0xe8934a, // high      — orange
  3: 0xe0c34a, // moderate  — yellow
  2: 0x5b7a94, // low       — blue-grey
  1: 0x4a4f57, // info      — dim grey
};

const PIN_ACCENT = 0x5ad1e0;

const MIN_PLANET_RADIUS = 1.6;
const MAX_PLANET_RADIUS = 7.0;

// Where planets sit relative to the viewer. Newer stories float nearer, older
// ones drift out toward the edge of the field. The near limit is kept well back
// so even the largest planet reads as an object in space rather than a wall.
const NEAR_DISTANCE = 62;
const FAR_DISTANCE = 230;
const PINNED_DISTANCE = 52;
const AGE_REFERENCE_HOURS = 72;
// Keep the field close to a horizontal band; a full sphere puts most planets
// out of frame above and below the viewer.
const ELEVATION_SPREAD = 0.42;

const FADE_FLOOR = 0.28;
const DIM_OPACITY = 0.08;

function mulberry32(seed) {
  let a = seed;
  return function random() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Procedural surface: banding plus speckle, tinted by the severity colour. Built
 * on a canvas so the app needs no network access for textures.
 */
function makePlanetTexture(colorHex, seed, tier) {
  const w = 256;
  const h = 128;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  const rand = mulberry32(Math.floor(seed * 0xffffffff) || 1);

  const base = new THREE.Color(colorHex);
  const light = base.clone().offsetHSL(0, 0.02, 0.16);
  const dark = base.clone().offsetHSL(0, -0.02, -0.18);

  const bg = ctx.createLinearGradient(0, 0, 0, h);
  bg.addColorStop(0, `#${dark.getHexString()}`);
  bg.addColorStop(0.5, `#${base.getHexString()}`);
  bg.addColorStop(1, `#${dark.getHexString()}`);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  // Latitude bands give the sphere a sense of rotation.
  const bands = 5 + Math.floor(rand() * 5);
  for (let i = 0; i < bands; i += 1) {
    const y = rand() * h;
    const thickness = 3 + rand() * 12;
    ctx.globalAlpha = 0.06 + rand() * 0.12;
    ctx.fillStyle = `#${(rand() > 0.5 ? light : dark).getHexString()}`;
    ctx.fillRect(0, y, w, thickness);
  }

  // Speckle for surface detail; higher tiers get a hotter, busier surface.
  const speckles = 180 + tier * 40;
  for (let i = 0; i < speckles; i += 1) {
    ctx.globalAlpha = 0.05 + rand() * 0.16;
    ctx.fillStyle = `#${(rand() > 0.45 ? light : dark).getHexString()}`;
    ctx.beginPath();
    ctx.arc(rand() * w, rand() * h, 1 + rand() * 3.5, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.globalAlpha = 1;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

let ringTexture = null;
function makeRingTexture() {
  if (ringTexture) return ringTexture;
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, size, 0);
  g.addColorStop(0, 'rgba(90,209,224,0)');
  g.addColorStop(0.5, 'rgba(90,209,224,0.95)');
  g.addColorStop(1, 'rgba(90,209,224,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  ringTexture = new THREE.CanvasTexture(canvas);
  return ringTexture;
}

export function planetRadiusFor(article) {
  const blast = Math.max(0, Math.min(1, article.blast_radius ?? 0.2));
  return MIN_PLANET_RADIUS + (MAX_PLANET_RADIUS - MIN_PLANET_RADIUS) * blast;
}

export function colorForTier(tier) {
  return TIER_COLOR[tier] || TIER_COLOR[1];
}

export function createPlanet(article, { showPinRing = true } = {}) {
  const tier = article.severity_tier || 1;
  const color = colorForTier(tier);
  const radius = planetRadiusFor(article);
  const seed = article.orbit_seed ?? 0.5;

  const group = new THREE.Group();

  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(radius, 32, 24),
    new THREE.MeshStandardMaterial({
      map: makePlanetTexture(color, seed, tier),
      roughness: 0.92,
      metalness: 0.04,
      transparent: true,
    }),
  );
  mesh.userData.article = article;
  group.add(mesh);

  // Critical and high planets carry a faint atmosphere so they read as hot even
  // at distance, where the surface texture is too small to see.
  if (tier >= 4) {
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({
      map: makeRadialGlow(color),
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      opacity: tier === 5 ? 0.5 : 0.32,
    }));
    halo.scale.set(radius * 5.2, radius * 5.2, 1);
    group.add(halo);
    group.userData.halo = halo;
  }

  if (showPinRing && article.pinned) {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(radius * 1.5, radius * 2.05, 64),
      new THREE.MeshBasicMaterial({
        map: makeRingTexture(),
        color: PIN_ACCENT,
        transparent: true,
        opacity: 0.85,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    ring.rotation.x = Math.PI / 2.3;
    ring.rotation.z = seed * Math.PI;
    group.add(ring);
    group.userData.ring = ring;
  }

  group.userData.article = article;
  group.userData.mesh = mesh;
  group.userData.radius = radius;
  group.userData.spinSpeed = 0.05 + seed * 0.09;
  group.userData.phase = seed * Math.PI * 2;

  return group;
}

const glowCache = new Map();
function makeRadialGlow(colorHex) {
  if (glowCache.has(colorHex)) return glowCache.get(colorHex);
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const c = new THREE.Color(colorHex);
  const rgb = `${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)}`;
  const g = ctx.createRadialGradient(size / 2, size / 2, size * 0.16, size / 2, size / 2, size / 2);
  g.addColorStop(0, `rgba(${rgb},0.55)`);
  g.addColorStop(0.45, `rgba(${rgb},0.14)`);
  g.addColorStop(1, `rgba(${rgb},0)`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  glowCache.set(colorHex, tex);
  return tex;
}

function ageHoursOf(article) {
  return Math.max(0, (Date.now() - new Date(article.published_at).getTime()) / 3_600_000);
}

/**
 * A narrow viewport spans a much smaller horizontal angle, so fewer of the
 * surrounding planets fall inside the frame at once. Drawing the field closer on
 * small screens makes the ones that are in view fill it, instead of leaving a
 * phone looking at a single distant speck.
 */
export function distanceScale() {
  const w = window.innerWidth;
  if (w < 520) return 0.52;
  if (w < 768) return 0.68;
  if (w < 1100) return 0.86;
  return 1;
}

/**
 * Place a planet in the surrounding field. Position is stable across reloads
 * (derived from orbit_seed), with a slow drift toward and away from the viewer
 * so planets approach, reveal their label, and recede again.
 */
/**
 * Spread planets evenly around the viewer.
 *
 * Azimuth taken straight from orbit_seed clumps badly at this population size —
 * random angles leave crowded arcs next to empty ones. Assigning evenly spaced
 * slots in a stable id order and jittering each by its own seed keeps the field
 * balanced while remaining reproducible across reloads.
 */
export function assignFieldSlots(groups) {
  const ordered = [...groups].sort((a, b) => (
    a.userData.article.id < b.userData.article.id ? -1 : 1
  ));
  const total = ordered.length || 1;
  const GOLDEN = 0.6180339887;

  ordered.forEach((group, index) => {
    const seed = group.userData.article.orbit_seed ?? 0.5;
    const spacing = (Math.PI * 2) / total;
    group.userData.azimuth = index * spacing + (seed - 0.5) * spacing * 0.55;

    // Golden-ratio sequence for elevation: successive planets land far apart
    // vertically, so the field fills the frame instead of settling into a band
    // across the middle. Hashing the seed alone left the top of the view empty.
    const t = (index * GOLDEN + seed * 0.13) % 1;
    group.userData.elevation = (t - 0.5) * 2 * ELEVATION_SPREAD;
  });
}

/**
 * Rotation to apply to the field so a given planet sits in front of the viewer.
 * Used to open on the most severe story rather than on whatever slot happened
 * to land ahead — with planets spread over a full circle, the opening view is
 * otherwise arbitrary.
 */
export function rotationToFace(group) {
  const azimuth = group.userData.azimuth ?? 0;
  // A point at local azimuth `a` appears at world azimuth `a - rotation.y`, and
  // straight ahead (the -Z axis) is world azimuth -PI/2.
  return azimuth + Math.PI / 2;
}

export function updatePlanetTransform(group, elapsed, dt, { distanceMode = 'age' } = {}) {
  const { article, phase } = group.userData;
  const seed = article.orbit_seed ?? 0.5;

  let base;
  if (article.pinned && distanceMode === 'age') {
    base = PINNED_DISTANCE + seed * 6;
  } else if (distanceMode === 'tier') {
    // Saved view: severity decides how near a planet sits, since age is moot.
    const tier = article.severity_tier || 1;
    base = NEAR_DISTANCE + (5 - tier) * 22 + seed * 10;
  } else {
    const ageFrac = Math.min(ageHoursOf(article) / AGE_REFERENCE_HOURS, 1);
    base = NEAR_DISTANCE + (FAR_DISTANCE - NEAR_DISTANCE) * ageFrac;
  }

  // Slow breathing so the field never looks frozen and planets drift in and out
  // of label range on their own.
  const breathe = 1 + Math.sin(elapsed * 0.06 + phase) * 0.09;
  const distance = base * breathe * distanceScale();

  const azimuth = group.userData.azimuth ?? seed * Math.PI * 2;
  const elevation = (group.userData.elevation ?? 0)
    + Math.sin(elapsed * 0.05 + phase) * 0.02;

  group.position.set(
    Math.cos(azimuth) * Math.cos(elevation) * distance,
    Math.sin(elevation) * distance,
    Math.sin(azimuth) * Math.cos(elevation) * distance,
  );

  group.userData.mesh.rotation.y += dt * group.userData.spinSpeed;
  if (group.userData.ring) group.userData.ring.rotation.z += dt * 0.05;
}

export function updatePlanetAppearance(group, matchesFilter, { fadeEnabled = true } = {}) {
  const { article, mesh, halo } = group.userData;

  let baseOpacity = 1;
  if (fadeEnabled && !article.pinned) {
    const ageFrac = Math.min(ageHoursOf(article) / AGE_REFERENCE_HOURS, 1);
    baseOpacity = Math.max(FADE_FLOOR, 1 - (1 - FADE_FLOOR) * ageFrac);
  }

  const opacity = matchesFilter ? baseOpacity : DIM_OPACITY;
  mesh.material.opacity = opacity;
  if (halo) halo.material.opacity = opacity * (article.severity_tier === 5 ? 0.5 : 0.32);
  if (group.userData.ring) group.userData.ring.material.opacity = matchesFilter ? 0.85 : 0.1;
}
