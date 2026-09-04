import * as THREE from '/vendor/three/build/three.module.js';

/**
 * The viewer sits at the origin and the field of planets surrounds them,
 * rotating slowly around the viewport itself. Nothing is orbited: there is no
 * centre object, and the sun is a distant background star that lights the scene
 * from far off rather than something the planets circle.
 *
 * Dragging turns the camera in place (a look-around), so the planets keep their
 * positions in space while the view sweeps across them.
 */

const FIELD_ROTATION_SPEED = 0.0055; // radians/sec — a full sweep takes ~19 min
const STARFIELD_ROTATION_SPEED = 0.0009; // slower, for parallax against the field
const MIN_FOV = 38;
const MAX_FOV = 92;
const PITCH_LIMIT = Math.PI * 0.38;
// The field is spread around the viewer, so how much of it is in frame depends
// on the *horizontal* angle of view. Holding that constant and deriving the
// vertical FOV from the aspect ratio keeps a phone from staring down a narrow
// corridor and seeing one planet.
const TARGET_HORIZONTAL_FOV = 82;

function verticalFovFor(aspect, zoom = 1) {
  const hFov = (TARGET_HORIZONTAL_FOV * Math.PI) / 180;
  const vFov = 2 * Math.atan(Math.tan(hFov / 2) / Math.max(aspect, 0.35));
  return Math.max(MIN_FOV, Math.min(MAX_FOV, (vFov * 180) / Math.PI * zoom));
}

function makeStarSpriteTexture() {
  const size = 32;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.35, 'rgba(255,255,255,0.55)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(canvas);
}

function createStarfield() {
  const STAR_COUNT = 5200;
  const RADIUS_MIN = 700;
  const RADIUS_MAX = 1600;

  const positions = new Float32Array(STAR_COUNT * 3);
  const colors = new Float32Array(STAR_COUNT * 3);
  const sizes = new Float32Array(STAR_COUNT);
  const tint = new THREE.Color();

  for (let i = 0; i < STAR_COUNT; i += 1) {
    const radius = RADIUS_MIN + Math.random() * (RADIUS_MAX - RADIUS_MIN);
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);

    positions[i * 3] = radius * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = radius * Math.sin(phi) * Math.sin(theta);
    positions[i * 3 + 2] = radius * Math.cos(phi);

    // Mostly cool white with a few warmer stars, so the field is not flat grey.
    const warmth = Math.random();
    tint.setHSL(0.58 - warmth * 0.14, 0.22, 0.72 + Math.random() * 0.24);
    colors[i * 3] = tint.r;
    colors[i * 3 + 1] = tint.g;
    colors[i * 3 + 2] = tint.b;
    sizes[i] = Math.random() < 0.06 ? 3.4 : 1.5 + Math.random() * 1.1;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1));

  const material = new THREE.PointsMaterial({
    size: 2.2,
    map: makeStarSpriteTexture(),
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    sizeAttenuation: false,
  });

  return new THREE.Points(geometry, material);
}

function makeGlowTexture(inner, mid) {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, inner);
  g.addColorStop(0.25, mid);
  g.addColorStop(1, 'rgba(255,190,110,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(canvas);
}

/**
 * A distant star, far outside the planet field. It is a light source and a
 * point of orientation, not something anything orbits.
 */
function createDistantStar() {
  const group = new THREE.Group();
  // Placed up and behind the viewer's default heading, so it lights the faces
  // of the planets the camera is looking at instead of back-lighting them into
  // silhouettes. Turn around and you see the star itself.
  group.position.set(-760, 330, 690);

  const glow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: makeGlowTexture('rgba(255,244,222,0.95)', 'rgba(255,206,140,0.35)'),
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  }));
  glow.scale.set(260, 260, 1);
  group.add(glow);

  const core = new THREE.Sprite(new THREE.SpriteMaterial({
    map: makeGlowTexture('rgba(255,255,255,1)', 'rgba(255,238,206,0.8)'),
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  }));
  core.scale.set(70, 70, 1);
  group.add(core);

  return group;
}

export function initScene(container) {
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x05070c, 0.0016);

  const aspect0 = container.clientWidth / container.clientHeight;
  const camera = new THREE.PerspectiveCamera(verticalFovFor(aspect0), aspect0, 0.1, 4000);
  camera.position.set(0, 0, 0);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.setClearColor(0x05070c, 1);
  container.appendChild(renderer.domElement);

  const starfield = createStarfield();
  scene.add(starfield);

  const star = createDistantStar();
  scene.add(star);

  // `field` holds the planets and provides the slow sweep around the viewer.
  const field = new THREE.Group();
  scene.add(field);

  scene.add(new THREE.AmbientLight(0x33465f, 2.2));
  const key = new THREE.DirectionalLight(0xfff0d8, 3.1);
  key.position.copy(star.position);
  scene.add(key);
  // A cool rim from the opposite side keeps the unlit hemisphere from going
  // fully black, so planets stay legible as spheres rather than dark discs.
  const rim = new THREE.DirectionalLight(0x5f83b8, 1.0);
  rim.position.set(640, -260, -820);
  scene.add(rim);

  // --- look-around controls: drag turns the camera where it stands ---
  let yaw = 0;
  let pitch = 0;
  let targetYaw = 0;
  let targetPitch = 0;
  let dragging = false;
  let lastX = 0;
  let lastY = 0;

  const el = renderer.domElement;

  el.addEventListener('pointerdown', (e) => {
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    el.setPointerCapture(e.pointerId);
  });
  el.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    targetYaw -= (e.clientX - lastX) * 0.0026;
    targetPitch -= (e.clientY - lastY) * 0.0026;
    targetPitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, targetPitch));
    lastX = e.clientX;
    lastY = e.clientY;
  });
  const endDrag = (e) => {
    dragging = false;
    if (e.pointerId !== undefined && el.hasPointerCapture?.(e.pointerId)) {
      el.releasePointerCapture(e.pointerId);
    }
  };
  el.addEventListener('pointerup', endDrag);
  el.addEventListener('pointercancel', endDrag);

  // Scroll narrows the field of view, which reads as leaning in rather than
  // travelling — there is no centre to move toward.
  let zoom = 1;
  el.addEventListener('wheel', (e) => {
    e.preventDefault();
    zoom = Math.max(0.55, Math.min(1.45, zoom + Math.sign(e.deltaY) * 0.06));
    camera.fov = verticalFovFor(camera.aspect, zoom);
    camera.updateProjectionMatrix();
  }, { passive: false });

  function handleResize() {
    const { clientWidth, clientHeight } = container;
    camera.aspect = clientWidth / clientHeight;
    camera.fov = verticalFovFor(camera.aspect, zoom);
    camera.updateProjectionMatrix();
    renderer.setSize(clientWidth, clientHeight);
  }
  window.addEventListener('resize', handleResize);

  const updateCallbacks = [];
  function onUpdate(fn) {
    updateCallbacks.push(fn);
  }

  const clock = new THREE.Clock();
  function animate() {
    requestAnimationFrame(animate);
    const dt = Math.min(clock.getDelta(), 0.1);
    const elapsed = clock.getElapsedTime();

    field.rotation.y += dt * FIELD_ROTATION_SPEED;
    starfield.rotation.y += dt * STARFIELD_ROTATION_SPEED;

    // Ease toward the dragged orientation so movement keeps a little weight.
    yaw += (targetYaw - yaw) * Math.min(1, dt * 6);
    pitch += (targetPitch - pitch) * Math.min(1, dt * 6);
    camera.rotation.set(pitch, yaw, 0, 'YXZ');

    for (const fn of updateCallbacks) fn(dt, elapsed);
    renderer.render(scene, camera);
  }
  animate();

  return {
    scene, camera, renderer, field, onUpdate,
  };
}

export function setupPlanetClicks(renderer, camera, getInteractiveObjects, onHit) {
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let downPos = null;

  renderer.domElement.addEventListener('pointerdown', (event) => {
    downPos = { x: event.clientX, y: event.clientY };
  });

  renderer.domElement.addEventListener('pointerup', (event) => {
    if (!downPos) return;
    const dx = event.clientX - downPos.x;
    const dy = event.clientY - downPos.y;
    downPos = null;
    // Ignore drags (look-around), only treat near-stationary clicks as selection.
    if (Math.hypot(dx, dy) > 4) return;

    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects(getInteractiveObjects(), false);
    if (hits.length > 0) onHit(hits[0].object);
  });
}
