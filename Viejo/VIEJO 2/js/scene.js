/* ============================================================================
   INKORA · scene.js
   ----------------------------------------------------------------------------
   Construcción de la escena Three.js a partir del estado del modelo.

   Filosofía: la escena NUNCA se edita incrementalmente. Después de cada
   cambio se reconstruye entera desde Model.state (los documentos de
   llaveros son chicos, la reconstrucción tarda milisegundos). Esto elimina
   toda una familia de bugs de desincronización del programa anterior.

   Mundo con eje Z hacia arriba (igual que el laminador y el DXF):
   las extrusiones crecen en +Z sin rotaciones intermedias.

   Elementos generados:
   · Caras 2D activas   — ShapeGeometry plano + contorno de línea
   · Piezas extruidas   — ExtrudeGeometry + aristas resaltadas
   · Resaltado de selección — tinte + overlay en la cara top/bottom elegida
   ============================================================================ */
(function (global) {
'use strict';

const INKORA = global.INKORA = global.INKORA || {};
const U = INKORA.Utils;

/* Colores de la escena (tema claro azul marino/blanco). */
const COLORS = {
  outline: 0x2e4e7e,        // contornos de caras 2D
  edges: 0x1d3557,          // aristas de piezas
  select: 0x2f6fd6,         // acento de selección
  selectFill: 0x3f7fe8,
};

/* Separación vertical entre caras 2D anidadas para evitar z-fighting. */
const FACE2D_LIFT = 0.06;

let scene = null;
let root = null;            // grupo con todo el contenido reconstruible
let pickMeshes = [];        // mallas susceptibles de raycast

/** Inicializa luces y piso. Se llama una vez desde el viewport. */
function init(threeScene) {
  scene = threeScene;

  // luz ambiente hemisférica + direccional principal + relleno
  const hemi = new THREE.HemisphereLight(0xffffff, 0xdde5f0, 0.95);
  hemi.position.set(0, 0, 1);
  scene.add(hemi);

  const key = new THREE.DirectionalLight(0xffffff, 0.7);
  key.position.set(60, -50, 120);
  scene.add(key);

  const fill = new THREE.DirectionalLight(0xdfe9ff, 0.25);
  fill.position.set(-70, 60, 40);
  scene.add(fill);

  // grilla de referencia (GridHelper vive en XZ → rotar al plano XY)
  const grid = new THREE.GridHelper(400, 80, 0xc7d3e4, 0xe2e9f3);
  grid.rotation.x = Math.PI / 2;
  grid.position.z = -0.02;
  scene.add(grid);

  root = new THREE.Group();
  scene.add(root);
}

/** Libera geometrías y materiales de un objeto y sus hijos. */
function disposeDeep(obj) {
  obj.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) {
      if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose());
      else o.material.dispose();
    }
  });
}

/** THREE.Shape a partir de anillos {outer CCW, holes CW}. */
function shapeFromRings(rings) {
  const shape = new THREE.Shape(rings.outer.map((p) => new THREE.Vector2(p[0], p[1])));
  for (const h of rings.holes) {
    shape.holes.push(new THREE.Path(h.map((p) => new THREE.Vector2(p[0], p[1]))));
  }
  return shape;
}

/** Mezcla un color hex hacia el acento de selección (para tintar). */
function tinted(hex, t) {
  const c = new THREE.Color(hex);
  c.lerp(new THREE.Color(COLORS.selectFill), t);
  return c;
}

/**
 * Reconstruye TODO el contenido de la escena desde el estado.
 * Llamar después de cada cambio del modelo.
 */
function rebuild() {
  const M = INKORA.Model;
  const state = M.state;

  disposeDeep(root);
  root.clear();
  pickMeshes = [];

  /* ── Caras 2D activas (aún no extruidas) ── */
  for (const f of M.activeFaces2d()) {
    const rings = INKORA.Topology.regionRings(state.contours, {
      outer: f.contourIdx, holes: f.holes,
    });
    const shape = shapeFromRings(rings);
    const selected = state.selection.faces2d.has(f.id);
    const z = FACE2D_LIFT * (f.depth + 1);

    const geo = new THREE.ShapeGeometry(shape);
    const mat = new THREE.MeshBasicMaterial({
      color: selected ? tinted(f.color, 0.42) : new THREE.Color(f.color),
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.z = z;
    mesh.userData = { pick: 'face2d', id: f.id };
    root.add(mesh);
    pickMeshes.push(mesh);

    // contorno (exterior + agujeros) para que las caras se lean bien
    const lineMat = new THREE.LineBasicMaterial({
      color: selected ? COLORS.select : COLORS.outline,
      transparent: true,
      opacity: selected ? 1.0 : 0.55,
    });
    for (const ring of [rings.outer].concat(rings.holes)) {
      const lineGeo = new THREE.BufferGeometry().setFromPoints(
        ring.map((p) => new THREE.Vector3(p[0], p[1], z + 0.02))
      );
      const loop = new THREE.LineLoop(lineGeo, lineMat);
      root.add(loop);
    }
  }

  /* ── Piezas extruidas ── */
  for (const p of state.pieces) {
    if (!p.visible) continue;
    const shapes = p.regions.map((r) =>
      shapeFromRings(INKORA.Topology.regionRings(state.contours, { outer: r.outer, holes: r.holes }))
    );
    const selFace = state.selection.pieceFaces.get(p.id) || null;

    const geo = new THREE.ExtrudeGeometry(shapes, {
      depth: p.height,
      bevelEnabled: false,
      curveSegments: 12,
    });
    const mat = new THREE.MeshStandardMaterial({
      color: selFace ? tinted(p.color, 0.28) : new THREE.Color(p.color),
      roughness: 0.62,
      metalness: 0.05,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.z = p.baseZ;
    mesh.userData = { pick: 'piece', id: p.id };
    root.add(mesh);
    pickMeshes.push(mesh);

    // aristas para que las piezas (sobre todo blancas) se lean nítidas
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(geo, 24),
      new THREE.LineBasicMaterial({
        color: selFace ? COLORS.select : COLORS.edges,
        transparent: true,
        opacity: selFace ? 0.95 : 0.35,
      })
    );
    edges.position.z = p.baseZ;
    root.add(edges);

    // overlay de la cara seleccionada (top o bottom)
    if (selFace) {
      const capGeo = new THREE.ShapeGeometry(shapes);
      const capMat = new THREE.MeshBasicMaterial({
        color: COLORS.selectFill,
        transparent: true,
        opacity: 0.4,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const cap = new THREE.Mesh(capGeo, capMat);
      cap.position.z = selFace === 'top' ? p.baseZ + p.height + 0.03 : p.baseZ - 0.03;
      root.add(cap);
    }
  }
}

/** Mallas para el raycaster del viewport. */
function pickables() { return pickMeshes; }

/** Caja 3D del contenido (para encuadrar la cámara). */
function contentBounds() {
  const box = new THREE.Box3();
  if (root && root.children.length) box.setFromObject(root);
  if (box.isEmpty()) box.set(new THREE.Vector3(-50, -50, 0), new THREE.Vector3(50, 50, 10));
  return box;
}

INKORA.SceneBuilder = { init, rebuild, pickables, contentBounds, COLORS };
})(typeof window !== 'undefined' ? window : globalThis);
