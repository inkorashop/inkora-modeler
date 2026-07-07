/* ============================================================================
   INKORA · viewport.js
   ----------------------------------------------------------------------------
   Render 3D y navegación. Mundo con Z hacia arriba.

   Controles:
   · Clic izquierdo         — seleccionar (Shift = sumar, Ctrl = alternar)
   · Arrastrar izquierdo    — orbitar (si supera el umbral de clic)
   · Shift + arrastrar izq. — panear
   · Botón derecho / medio  — panear / orbitar
   · Rueda                  — zoom hacia el cursor
   · F                      — encuadrar el modelo (desde main.js)

   Render bajo demanda: solo se re-dibuja cuando algo cambió (fluidez y
   consumo mínimo de GPU/batería).
   ============================================================================ */
(function (global) {
'use strict';

const INKORA = global.INKORA = global.INKORA || {};

const BG_COLOR = 0xeef2f8;          // fondo del viewport (tema claro)
const CLICK_THRESHOLD = 5;          // px: menos que esto es clic, no arrastre

let renderer, camera, scene, container;
let needsRender = true;

/* Cámara orbital: esféricas alrededor de un objetivo. */
const orbit = {
  target: null,                     // THREE.Vector3
  radius: 220,
  theta: -Math.PI / 3,              // azimut alrededor de Z
  phi: Math.PI / 3.2,               // ángulo polar desde +Z
};

/* Estado del puntero durante un arrastre. */
const drag = {
  active: false, button: -1, mode: null,   // 'orbit' | 'pan'
  startX: 0, startY: 0, lastX: 0, lastY: 0,
  moved: false, shift: false, ctrl: false,
};

const raycaster = typeof THREE !== 'undefined' ? new THREE.Raycaster() : null;

/** Coloca la cámara según los parámetros orbitales. */
function applyOrbit() {
  const sp = Math.sin(orbit.phi), cp = Math.cos(orbit.phi);
  camera.position.set(
    orbit.target.x + orbit.radius * sp * Math.cos(orbit.theta),
    orbit.target.y + orbit.radius * sp * Math.sin(orbit.theta),
    orbit.target.z + orbit.radius * cp
  );
  camera.up.set(0, 0, 1);
  camera.lookAt(orbit.target);
  needsRender = true;
}

/** Inicializa renderer, cámara, escena y eventos. */
function init(containerEl) {
  container = containerEl;

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(container.clientWidth, container.clientHeight);
  container.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  scene.background = new THREE.Color(BG_COLOR);

  camera = new THREE.PerspectiveCamera(
    42, container.clientWidth / Math.max(1, container.clientHeight), 0.5, 6000
  );
  orbit.target = new THREE.Vector3(0, 0, 0);
  applyOrbit();

  INKORA.SceneBuilder.init(scene);

  /* ── eventos de puntero ── */
  const el = renderer.domElement;
  el.style.touchAction = 'none';

  el.addEventListener('pointerdown', onPointerDown);
  el.addEventListener('pointermove', onPointerMove);
  el.addEventListener('pointerup', onPointerUp);
  el.addEventListener('pointerleave', onPointerUp);
  el.addEventListener('wheel', onWheel, { passive: false });
  el.addEventListener('contextmenu', (e) => e.preventDefault());

  /* ── redimensionado ── */
  new ResizeObserver(() => {
    const w = container.clientWidth, h = Math.max(1, container.clientHeight);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    needsRender = true;
  }).observe(container);

  /* ── bucle de render bajo demanda ── */
  (function loop() {
    requestAnimationFrame(loop);
    if (needsRender) {
      needsRender = false;
      renderer.render(scene, camera);
    }
  })();
}

/* ─────────────────────────── Navegación ────────────────────────────────── */

function onPointerDown(e) {
  drag.active = true;
  drag.button = e.button;
  drag.startX = drag.lastX = e.clientX;
  drag.startY = drag.lastY = e.clientY;
  drag.moved = false;
  drag.shift = e.shiftKey;
  drag.ctrl = e.ctrlKey || e.metaKey;
  drag.mode = (e.button === 2 || (e.button === 0 && e.shiftKey)) ? 'pan'
            : (e.button === 0 || e.button === 1) ? 'orbit' : null;
  renderer.domElement.setPointerCapture(e.pointerId);
}

/* Última posición del cursor sobre el viewport (para anclar popovers
   abiertos por atajo de teclado, ej. la tecla "C" de color). */
const lastMouse = { x: 0, y: 0 };

function onPointerMove(e) {
  lastMouse.x = e.clientX;
  lastMouse.y = e.clientY;
  if (!drag.active) {
    updateHoverCursor(e);
    return;
  }
  const dx = e.clientX - drag.lastX;
  const dy = e.clientY - drag.lastY;
  drag.lastX = e.clientX;
  drag.lastY = e.clientY;
  if (Math.abs(e.clientX - drag.startX) + Math.abs(e.clientY - drag.startY) > CLICK_THRESHOLD) {
    drag.moved = true;
  }
  if (!drag.moved || !drag.mode) return;

  renderer.domElement.style.cursor = 'grabbing';
  if (drag.mode === 'orbit') {
    orbit.theta -= dx * 0.006;
    orbit.phi = Math.min(Math.PI - 0.03, Math.max(0.03, orbit.phi - dy * 0.006));
  } else {
    // panear: mover el objetivo en el plano de la cámara
    const scale = orbit.radius * 0.0016;
    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 0);
    const upv = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 1);
    orbit.target.addScaledVector(right, -dx * scale);
    orbit.target.addScaledVector(upv, dy * scale);
  }
  applyOrbit();
}

function onPointerUp(e) {
  if (!drag.active) return;
  const wasClick = !drag.moved && drag.button === 0;
  drag.active = false;
  renderer.domElement.style.cursor = 'default';
  try { renderer.domElement.releasePointerCapture(e.pointerId); } catch (_) { /* ya liberado */ }
  if (wasClick) handleClick(e);
}

function onWheel(e) {
  e.preventDefault();
  const factor = e.deltaY > 0 ? 1.12 : 1 / 1.12;
  // acercar el objetivo hacia el punto bajo el cursor (zoom "al cursor")
  const hit = planePointUnderCursor(e);
  if (hit && factor < 1) orbit.target.lerp(hit, 0.22);
  orbit.radius = Math.min(4000, Math.max(5, orbit.radius * factor));
  applyOrbit();
}

/** Intersección del rayo del cursor con el plano Z=0 (para el zoom). */
function planePointUnderCursor(e) {
  const ndc = eventNdc(e);
  raycaster.setFromCamera(ndc, camera);
  const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
  const out = new THREE.Vector3();
  return raycaster.ray.intersectPlane(plane, out) ? out : null;
}

function eventNdc(e) {
  const r = renderer.domElement.getBoundingClientRect();
  return new THREE.Vector2(
    ((e.clientX - r.left) / r.width) * 2 - 1,
    -((e.clientY - r.top) / r.height) * 2 + 1
  );
}

/* ─────────────────────────── Selección ─────────────────────────────────── */

/** Raycast contra las mallas seleccionables. */
function pickAt(e) {
  raycaster.setFromCamera(eventNdc(e), camera);
  const hits = raycaster.intersectObjects(INKORA.SceneBuilder.pickables(), false);
  return hits.length ? hits[0] : null;
}

function handleClick(e) {
  const M = INKORA.Model;
  const mode = e.shiftKey ? 'add' : (e.ctrlKey || e.metaKey) ? 'toggle' : 'set';
  const hit = pickAt(e);

  if (!hit) {
    if (mode === 'set') M.clearSelection();
    return;
  }
  const ud = hit.object.userData;
  if (ud.pick === 'face2d') {
    M.selectFace2d(ud.id, mode);
  } else if (ud.pick === 'piece') {
    // cara según la normal del triángulo tocado (la malla no está rotada)
    const nz = hit.face ? hit.face.normal.z : 1;
    const face = nz > 0.5 ? 'top' : nz < -0.5 ? 'bottom' : 'top';
    M.selectPieceFace(ud.id, face, mode);
  }
}

/* Cursor "pointer" al pasar sobre algo clicable (limitado a ~20 fps). */
let lastHover = 0;
function updateHoverCursor(e) {
  const now = performance.now();
  if (now - lastHover < 50) return;
  lastHover = now;
  renderer.domElement.style.cursor = pickAt(e) ? 'pointer' : 'default';
}

/* ─────────────────────────── Encuadre ──────────────────────────────────── */

/** Encuadra el contenido actual (tecla F y tras importar). */
function frame() {
  const box = INKORA.SceneBuilder.contentBounds();
  const sphere = new THREE.Sphere();
  box.getBoundingSphere(sphere);
  orbit.target.copy(sphere.center);
  const fov = (camera.fov * Math.PI) / 180;
  orbit.radius = Math.max(20, (sphere.radius * 1.35) / Math.sin(fov / 2));
  applyOrbit();
}

/** Marca la escena como sucia (re-render en el próximo frame). */
function requestRender() { needsRender = true; }

INKORA.Viewport = { init, frame, requestRender, lastMouse };
})(typeof window !== 'undefined' ? window : globalThis);
