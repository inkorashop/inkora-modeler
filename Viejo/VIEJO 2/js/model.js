/* ============================================================================
   INKORA · model.js
   ----------------------------------------------------------------------------
   Modelo de documento: el estado ÚNICO de la aplicación y todas las
   operaciones que lo mutan. La escena 3D y la interfaz se reconstruyen
   siempre a partir de este estado (fuente única de verdad), lo que hace
   que undo/redo, borrado y re-extrusión sean confiables por construcción.

   Conceptos:
   · contours  — geometría estática importada (nunca cambia tras importar)
   · faces2d   — caras planas seleccionables derivadas de la topología
                 (sólidos e interiores respaldados). Al extruirse quedan
                 "consumidas" hasta que su pieza se borre.
   · pieces    — sólidos extruidos. Guardan REFERENCIAS a los contornos
                 (índices), no copias de puntos: por eso la re-extrusión
                 nunca pierde los agujeros interiores.
   · groups    — agrupaciones de elementos de la lista (renombrables).
   · selection — caras 2D seleccionadas + caras de piezas (top/bottom).

   Eventos (Model.events):
   · 'doc'    — documento nuevo importado
   · 'change' — el estado cambió (reconstruir escena + UI)
   ============================================================================ */
(function (global) {
'use strict';

const INKORA = global.INKORA = global.INKORA || {};
const U = INKORA.Utils;

const DEFAULT_COLOR = '#c9d2de';   // gris azulado para contornos sin color

const state = {
  docName: null,
  contours: [],       // enriquecidos por Topology.classify
  faces2d: [],        // ver newDocument()
  pieces: [],
  groups: [],
  counters: { fig: 0, int: 0, piece: 0, merged: 0, group: 0 },
  selection: {
    faces2d: new Set(),        // ids de face2d
    pieceFaces: new Map(),     // pieceId → 'top' | 'bottom'
  },
};

const events = U.Emitter();

/* Historial: el modelo avisa después de cada mutación real. Durante un
   restore se suprime para no generar entradas espurias. */
let suppressHistory = false;

function afterMutation(label) {
  if (!suppressHistory && INKORA.History) INKORA.History.push(label);
  events.emit('change');
}

/* ─────────────────────────── Documento nuevo ───────────────────────────── */

/**
 * Crea un documento desde el resultado del parser (DXF o portapapeles).
 * @param {{contours:Array, warnings:string[]}} parsed
 * @param {string} name nombre base (sin extensión)
 * @returns {string[]} warnings acumulados
 */
function newDocument(parsed, name) {
  const topo = INKORA.Topology.classify(parsed.contours);

  state.docName = name || 'llavero';
  state.contours = topo.contours;
  state.pieces = [];
  state.groups = [];
  state.counters = { fig: 0, int: 0, piece: 0, merged: 0, group: 0 };
  state.selection.faces2d.clear();
  state.selection.pieceFaces.clear();

  state.faces2d = topo.faces.map((f) => {
    const isSolid = f.kind === 'solid';
    const n = isSolid ? ++state.counters.fig : ++state.counters.int;
    return {
      id: U.newId('cara'),
      contourIdx: f.contourIdx,
      kind: f.kind,                    // 'solid' | 'interior'
      holes: f.holes,                  // índices de contornos-agujero
      color: f.color || DEFAULT_COLOR,
      name: (isSolid ? 'Figura ' : 'Interior ') + n,
      depth: f.depth,
      repPt: f.repPt,
      extrudedPieceId: null,           // ≠ null ⇒ consumida por esa pieza
      deleted: false,
      visible: true,
    };
  });

  events.emit('doc');
  if (INKORA.History) INKORA.History.reset('Importación');
  events.emit('change');
  return (parsed.warnings || []).concat(topo.warnings || []);
}

/* ──────────────────────────── Consultas ────────────────────────────────── */

function getFace(id)  { return state.faces2d.find((f) => f.id === id) || null; }
function getPiece(id) { return state.pieces.find((p) => p.id === id) || null; }
function getGroup(id) { return state.groups.find((g) => g.id === id) || null; }

/** Caras 2D activas: visibles, no borradas y todavía no extruidas. */
function activeFaces2d() {
  return state.faces2d.filter((f) => !f.deleted && !f.extrudedPieceId && f.visible);
}

/** true si la región rellena de la pieza cubre el punto (x,y). */
function pieceCoversPoint(piece, pt) {
  for (const reg of piece.regions) {
    if (!U.pointInPolygon(pt, state.contours[reg.outer].pts)) continue;
    let inHole = false;
    for (const h of reg.holes) {
      if (U.pointInPolygon(pt, state.contours[h].pts)) { inHole = true; break; }
    }
    if (!inHole) return true;
  }
  return false;
}

/**
 * Altura de apoyo para extruir sobre el punto dado: el techo más alto de
 * las piezas visibles que cubren ese punto (0 = plato).
 */
function supportTopAt(pt) {
  let top = 0;
  for (const p of state.pieces) {
    if (!p.visible) continue;
    if (pieceCoversPoint(p, pt)) top = Math.max(top, p.baseZ + p.height);
  }
  return top;
}

/** Bbox 2D del documento completo (para encuadrar la cámara). */
function docBbox() {
  const boxes = state.contours.filter((c) => !c.duplicate).map((c) => c.bbox);
  return U.bboxUnion(boxes);
}

/** Resumen de la selección para la UI. */
function selectionInfo() {
  const nf = state.selection.faces2d.size;
  const np = state.selection.pieceFaces.size;
  return { faces2d: nf, pieces: np, total: nf + np, empty: nf + np === 0 };
}

/* ──────────────────────────── Selección ────────────────────────────────── */

function clearSelection(silent) {
  state.selection.faces2d.clear();
  state.selection.pieceFaces.clear();
  if (!silent) events.emit('change');
}

/** Selecciona una cara 2D. mode: 'set' | 'add' | 'toggle'. */
function selectFace2d(id, mode) {
  const f = getFace(id);
  if (!f || f.deleted || f.extrudedPieceId) return;
  if (mode === 'toggle' && state.selection.faces2d.has(id)) {
    state.selection.faces2d.delete(id);
  } else {
    if (mode !== 'add' && mode !== 'toggle') clearSelection(true);
    state.selection.faces2d.add(id);
  }
  events.emit('change');
}

/** Selecciona una cara (top/bottom) de una pieza. */
function selectPieceFace(pieceId, face, mode) {
  const p = getPiece(pieceId);
  if (!p || !p.visible) return;
  const cur = state.selection.pieceFaces.get(pieceId);
  if (mode === 'toggle' && cur === face) {
    state.selection.pieceFaces.delete(pieceId);
  } else {
    if (mode !== 'add' && mode !== 'toggle') clearSelection(true);
    state.selection.pieceFaces.set(pieceId, face);
  }
  events.emit('change');
}

/** Selecciona un elemento de la lista (cara o pieza) por id. */
function selectItem(id, mode) {
  if (getPiece(id)) selectPieceFace(id, 'top', mode);
  else selectFace2d(id, mode);
}

/** Selecciona el grupo completo (todos sus miembros vivos). */
function selectGroup(groupId, mode) {
  const g = getGroup(groupId);
  if (!g) return;
  if (mode !== 'add') clearSelection(true);
  for (const id of g.memberIds) {
    const p = getPiece(id);
    if (p && p.visible) { state.selection.pieceFaces.set(id, 'top'); continue; }
    const f = getFace(id);
    if (f && !f.deleted && !f.extrudedPieceId && f.visible) state.selection.faces2d.add(id);
  }
  events.emit('change');
}

/** Caras superiores o inferiores de TODAS las piezas visibles. */
function selectAllPieceFaces(face) {
  clearSelection(true);
  for (const p of state.pieces) if (p.visible) state.selection.pieceFaces.set(p.id, face);
  events.emit('change');
}

/** Seleccionar todo: caras 2D activas + piezas por arriba. */
function selectAll() {
  clearSelection(true);
  for (const f of activeFaces2d()) state.selection.faces2d.add(f.id);
  for (const p of state.pieces) if (p.visible) state.selection.pieceFaces.set(p.id, 'top');
  events.emit('change');
}

/** Invierte la selección entre todo lo seleccionable (caras 2D activas + piezas visibles). */
function invertSelection() {
  const newFaces = new Set();
  for (const f of activeFaces2d()) if (!state.selection.faces2d.has(f.id)) newFaces.add(f.id);
  const newPieces = new Map();
  for (const p of state.pieces) {
    if (!p.visible) continue;
    if (!state.selection.pieceFaces.has(p.id)) newPieces.set(p.id, 'top');
  }
  state.selection.faces2d = newFaces;
  state.selection.pieceFaces = newPieces;
  events.emit('change');
}

/* ──────────────────────────── Extrusión ────────────────────────────────── */

/**
 * Extruye la selección actual.
 * @param {{height:number, mode:'separate'|'merged'}} opts
 * @returns {{ok:boolean, msg?:string, created?:number}}
 *
 * Reglas:
 * · Cara 2D  → pieza nueva apoyada sobre lo que tenga debajo (o el plato).
 * · Cara top de pieza    → pieza nueva encima (re-extrusión hacia arriba).
 * · Cara bottom de pieza → pieza nueva debajo (re-extrusión hacia abajo).
 * · Las regiones se guardan como índices de contorno, así los agujeros
 *   interiores se conservan intactos en cualquier re-extrusión.
 * · Se procesan primero las caras de mayor tamaño/menor profundidad para
 *   que, al extruir todo junto, las letras se apoyen sobre la base recién
 *   creada.
 */
function extrudeSelection(opts) {
  const height = Math.abs(parseFloat(opts.height));
  const mode = opts.mode === 'merged' ? 'merged' : 'separate';
  if (!height || !isFinite(height)) return { ok: false, msg: 'Altura de extrusión inválida.' };

  const sel = state.selection;
  if (sel.faces2d.size === 0 && sel.pieceFaces.size === 0) {
    return { ok: false, msg: 'No hay nada seleccionado para extruir.' };
  }

  // fuentes 2D ordenadas: exteriores primero (profundidad, luego área desc.)
  const faceSources = Array.from(sel.faces2d)
    .map(getFace)
    .filter(Boolean)
    .sort((a, b) => a.depth - b.depth ||
      state.contours[b.contourIdx].area - state.contours[a.contourIdx].area);

  const pieceSources = Array.from(sel.pieceFaces.entries())
    .map(([pid, face]) => ({ piece: getPiece(pid), face }))
    .filter((s) => s.piece);

  const created = [];

  if (mode === 'separate') {
    // ── una pieza por cada fuente ──
    for (const f of faceSources) {
      const baseZ = supportTopAt(f.repPt);
      created.push(makePiece({
        name: f.name,
        color: f.color,
        regions: [{ outer: f.contourIdx, holes: f.holes.slice() }],
        baseZ, height,
        srcFaceIds: [f.id],
      }));
      f.extrudedPieceId = created[created.length - 1].id;
    }
    for (const s of pieceSources) {
      const baseZ = s.face === 'bottom' ? s.piece.baseZ - height : s.piece.baseZ + s.piece.height;
      created.push(makePiece({
        name: s.piece.name + ' +',
        color: s.piece.color,
        regions: U.deepClone(s.piece.regions),
        baseZ, height,
        srcFaceIds: [],
      }));
    }
  } else {
    // ── una única pieza unida con todas las regiones ──
    const regions = [];
    const srcFaceIds = [];
    let baseZ = 0;
    let color = null;
    for (const f of faceSources) {
      regions.push({ outer: f.contourIdx, holes: f.holes.slice() });
      srcFaceIds.push(f.id);
      baseZ = Math.max(baseZ, supportTopAt(f.repPt));
      if (!color) color = f.color;
    }
    for (const s of pieceSources) {
      for (const r of U.deepClone(s.piece.regions)) regions.push(r);
      baseZ = Math.max(baseZ, s.face === 'bottom' ? s.piece.baseZ - height : s.piece.baseZ + s.piece.height);
      if (!color) color = s.piece.color;
    }
    if (regions.length === 0) return { ok: false, msg: 'La selección no tiene caras extruibles.' };
    const piece = makePiece({
      name: 'Unido ' + (++state.counters.merged),
      color: color || DEFAULT_COLOR,
      regions, baseZ, height,
      srcFaceIds,
    });
    for (const f of faceSources) f.extrudedPieceId = piece.id;
    created.push(piece);
  }

  // la selección pasa a las piezas nuevas (para encadenar operaciones)
  clearSelection(true);
  for (const p of created) state.selection.pieceFaces.set(p.id, 'top');

  afterMutation('Extrusión (' + created.length + ')');
  return { ok: true, created: created.length };
}

/** Crea una pieza y la agrega al estado. */
function makePiece({ name, color, regions, baseZ, height, srcFaceIds }) {
  state.counters.piece++;
  const piece = {
    id: U.newId('pieza'),
    name: name || 'Pieza ' + state.counters.piece,
    color: color || DEFAULT_COLOR,
    regions,                 // [{outer: contourIdx, holes: [contourIdx]}]
    baseZ: U.round(baseZ, 4),
    height: U.round(height, 4),
    srcFaceIds: srcFaceIds || [],
    visible: true,
  };
  state.pieces.push(piece);
  return piece;
}

/* ─────────────────────── Borrado y visibilidad ─────────────────────────── */

/**
 * Elimina la selección actual:
 * · Piezas seleccionadas → se quitan y sus caras 2D de origen vuelven a
 *   estar disponibles para extruir.
 * · Caras 2D seleccionadas → se marcan borradas (recuperables con Ctrl+Z).
 */
function deleteSelection() {
  const info = selectionInfo();
  if (info.empty) return { ok: false, msg: 'No hay nada seleccionado.' };

  const pieceIds = new Set(state.selection.pieceFaces.keys());
  for (const pid of pieceIds) {
    const p = getPiece(pid);
    if (!p) continue;
    // liberar caras de origen
    for (const fid of p.srcFaceIds) {
      const f = getFace(fid);
      if (f && f.extrudedPieceId === pid) f.extrudedPieceId = null;
    }
  }
  state.pieces = state.pieces.filter((p) => !pieceIds.has(p.id));

  for (const fid of state.selection.faces2d) {
    const f = getFace(fid);
    if (f) f.deleted = true;
  }

  cleanupGroups();
  clearSelection(true);
  afterMutation('Eliminar');
  return { ok: true };
}

/** Quita ids muertos de los grupos y elimina grupos vacíos. */
function cleanupGroups() {
  const alive = (id) => {
    const p = getPiece(id);
    if (p) return true;
    const f = getFace(id);
    return !!(f && !f.deleted);
  };
  for (const g of state.groups) g.memberIds = g.memberIds.filter(alive);
  state.groups = state.groups.filter((g) => g.memberIds.length > 0);
}

/** Alterna visibilidad de un elemento (cara, pieza o grupo). */
function toggleVisible(id) {
  const p = getPiece(id);
  if (p) { p.visible = !p.visible; afterMutation(p.visible ? 'Mostrar' : 'Ocultar'); return; }
  const f = getFace(id);
  if (f) { f.visible = !f.visible; afterMutation(f.visible ? 'Mostrar' : 'Ocultar'); return; }
  const g = getGroup(id);
  if (g) {
    // si algún miembro está visible → ocultar todos; si no → mostrar todos
    const anyVis = g.memberIds.some((mid) => {
      const mp = getPiece(mid); if (mp) return mp.visible;
      const mf = getFace(mid); return mf ? mf.visible : false;
    });
    for (const mid of g.memberIds) {
      const mp = getPiece(mid); if (mp) { mp.visible = !anyVis; continue; }
      const mf = getFace(mid); if (mf) mf.visible = !anyVis;
    }
    afterMutation(anyVis ? 'Ocultar grupo' : 'Mostrar grupo');
  }
}

/**
 * Duplica la pieza seleccionada (requiere exactamente una).
 * La copia comparte los mismos contornos de origen (regiones), color y
 * altura; queda apoyada en la misma posición que el original —a diferencia
 * de la versión anterior, esta reescritura no tiene herramienta de mover
 * piezas en XY, así que la copia no se desplaza sola—.
 */
function duplicateSelection() {
  if (state.selection.pieceFaces.size !== 1 || state.selection.faces2d.size > 0) {
    return { ok: false, msg: 'Seleccioná exactamente una pieza para duplicar.' };
  }
  const pid = state.selection.pieceFaces.keys().next().value;
  const src = getPiece(pid);
  if (!src) return { ok: false, msg: 'Seleccioná exactamente una pieza para duplicar.' };

  const piece = makePiece({
    name: src.name + ' copia',
    color: src.color,
    regions: U.deepClone(src.regions),
    baseZ: src.baseZ,
    height: src.height,
    srcFaceIds: [],
  });
  clearSelection(true);
  state.selection.pieceFaces.set(piece.id, 'top');
  afterMutation('Duplicar');
  return { ok: true };
}

/**
 * Aislar: oculta todas las piezas/caras NO seleccionadas, dejando solo la
 * selección visible. Si ya está todo aislado (nada más para ocultar),
 * vuelve a mostrar todo. Alterna igual que en la versión anterior.
 */
function isolateSelection() {
  const selPieceIds = new Set(state.selection.pieceFaces.keys());
  const selFaceIds = state.selection.faces2d;
  if (selPieceIds.size === 0 && selFaceIds.size === 0) {
    return { ok: false, msg: 'Seleccioná algo para aislar.' };
  }
  const others = [
    ...state.pieces.filter((p) => !selPieceIds.has(p.id)),
    ...state.faces2d.filter((f) => !f.deleted && !f.extrudedPieceId && !selFaceIds.has(f.id)),
  ];
  const alreadyIsolated = others.length > 0 && others.every((it) => !it.visible);
  for (const it of others) it.visible = alreadyIsolated;
  afterMutation(alreadyIsolated ? 'Mostrar todo' : 'Aislar');
  return { ok: true, isolated: !alreadyIsolated };
}

/* ─────────────────────── Color, nombre, altura ─────────────────────────── */

/** Aplica un color a toda la selección (caras 2D y piezas). */
function setColorForSelection(hex) {
  const color = U.normHex(hex);
  if (!color) return { ok: false, msg: 'Color inválido.' };
  let n = 0;
  for (const fid of state.selection.faces2d) {
    const f = getFace(fid);
    if (f) { f.color = color; n++; }
  }
  for (const pid of state.selection.pieceFaces.keys()) {
    const p = getPiece(pid);
    if (p) { p.color = color; n++; }
  }
  if (!n) return { ok: false, msg: 'No hay nada seleccionado.' };
  afterMutation('Color');
  return { ok: true };
}

/** Cambia el color de UN elemento (swatch de la lista). */
function setItemColor(id, hex) {
  const color = U.normHex(hex);
  if (!color) return;
  const p = getPiece(id);
  if (p) { p.color = color; afterMutation('Color'); return; }
  const f = getFace(id);
  if (f) { f.color = color; afterMutation('Color'); }
}

/** Renombra un elemento (cara, pieza o grupo). */
function renameItem(id, name) {
  name = String(name || '').trim();
  if (!name) return;
  const t = getPiece(id) || getFace(id) || getGroup(id);
  if (t && t.name !== name) { t.name = name; afterMutation('Renombrar'); }
}

/** Cambia la altura de las piezas seleccionadas (manteniendo su base). */
function setHeightForSelection(h) {
  const height = Math.abs(parseFloat(h));
  if (!height || !isFinite(height)) return { ok: false, msg: 'Altura inválida.' };
  let n = 0;
  for (const pid of state.selection.pieceFaces.keys()) {
    const p = getPiece(pid);
    if (p && p.height !== height) { p.height = U.round(height, 4); n++; }
  }
  if (!n) return { ok: false };
  afterMutation('Altura');
  return { ok: true };
}

/* ────────────────────────────── Grupos ─────────────────────────────────── */

/** Agrupa los elementos seleccionados en un grupo nuevo. */
function groupSelection() {
  const ids = [
    ...Array.from(state.selection.pieceFaces.keys()),
    ...Array.from(state.selection.faces2d),
  ];
  if (ids.length < 2) return { ok: false, msg: 'Seleccioná al menos 2 elementos para agrupar.' };
  // cada elemento pertenece a un solo grupo: quitarlo de los anteriores
  for (const g of state.groups) g.memberIds = g.memberIds.filter((m) => !ids.includes(m));
  state.groups = state.groups.filter((g) => g.memberIds.length > 0);
  state.groups.push({
    id: U.newId('grupo'),
    name: 'Grupo ' + (++state.counters.group),
    memberIds: ids,
    collapsed: false,
  });
  afterMutation('Agrupar');
  return { ok: true };
}

/** Desarma un grupo (los miembros quedan sueltos). */
function ungroup(groupId) {
  const before = state.groups.length;
  state.groups = state.groups.filter((g) => g.id !== groupId);
  if (state.groups.length !== before) afterMutation('Desagrupar');
}

/** Desarma los grupos que contengan elementos seleccionados. */
function ungroupSelection() {
  const ids = new Set([
    ...state.selection.pieceFaces.keys(),
    ...state.selection.faces2d,
  ]);
  const before = state.groups.length;
  state.groups = state.groups.filter((g) => !g.memberIds.some((m) => ids.has(m)));
  if (state.groups.length !== before) afterMutation('Desagrupar');
}

/** Grupo al que pertenece un elemento, o null. */
function groupOf(id) {
  return state.groups.find((g) => g.memberIds.includes(id)) || null;
}

/* ─────────────────── Snapshots (historial undo/redo) ───────────────────── */

/**
 * Captura el estado dinámico completo. Los contornos (estáticos) no se
 * copian: los snapshots son livianos y el historial nunca se corrompe.
 */
function snapshot() {
  return {
    faces2d: state.faces2d.map((f) => ({
      id: f.id,
      color: f.color,
      name: f.name,
      extrudedPieceId: f.extrudedPieceId,
      deleted: f.deleted,
      visible: f.visible,
    })),
    pieces: U.deepClone(state.pieces),
    groups: U.deepClone(state.groups),
    counters: U.deepClone(state.counters),
    idCounter: U.idCounter(),
  };
}

/** Restaura un snapshot (usado por History). No genera nueva entrada. */
function restore(snap) {
  suppressHistory = true;
  try {
    const byId = new Map(snap.faces2d.map((f) => [f.id, f]));
    for (const f of state.faces2d) {
      const s = byId.get(f.id);
      if (!s) continue;
      f.color = s.color;
      f.name = s.name;
      f.extrudedPieceId = s.extrudedPieceId;
      f.deleted = s.deleted;
      f.visible = s.visible;
    }
    state.pieces = U.deepClone(snap.pieces);
    state.groups = U.deepClone(snap.groups);
    state.counters = U.deepClone(snap.counters);
    U.bumpIdCounter(snap.idCounter);
    clearSelection(true);
  } finally {
    suppressHistory = false;
  }
  events.emit('change');
}

/* ────────────────────────────── Export ─────────────────────────────────── */

INKORA.Model = {
  state, events,
  DEFAULT_COLOR,
  newDocument,
  getFace, getPiece, getGroup, groupOf,
  activeFaces2d, docBbox, selectionInfo,
  supportTopAt, pieceCoversPoint,
  clearSelection, selectFace2d, selectPieceFace, selectItem, selectGroup,
  selectAllPieceFaces, selectAll, invertSelection,
  extrudeSelection, deleteSelection,
  setColorForSelection, setItemColor, renameItem, setHeightForSelection,
  toggleVisible, duplicateSelection, isolateSelection,
  groupSelection, ungroup, ungroupSelection,
  snapshot, restore,
};
})(typeof window !== 'undefined' ? window : globalThis);
