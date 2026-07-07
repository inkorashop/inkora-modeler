/* ============================================================================
   INKORA · ui.js
   ----------------------------------------------------------------------------
   Interfaz: panel lateral, lista de elementos, popover de colores, toasts,
   modal de atajos y barra de estado. Toda la UI se re-dibuja desde
   Model.state en refresh() — igual que la escena 3D, sin estado duplicado.

   Funciones principales:
   · refresh()        — re-dibuja lista, contadores y botones
   · toast(msg, type) — aviso flotante ('info' | 'ok' | 'warn' | 'error')
   · initUI()         — cablea todos los controles una vez
   ============================================================================ */
(function (global) {
'use strict';

const INKORA = global.INKORA = global.INKORA || {};
const U = INKORA.Utils;

/* Paleta rápida para llaveros (filamentos habituales). */
const PRESET_COLORS = [
  '#ffffff', '#000000', '#12294b', '#2f6fd6', '#00a2e8', '#00b8a9',
  '#22b14c', '#a8e61d', '#fff200', '#ffb340', '#ff7f27', '#ed1c24',
  '#e83e8c', '#a349a4', '#b97a57', '#c3c3c3',
];

/* Estado local de UI (no forma parte del documento). */
const uiState = {
  collapsedGroups: new Set(),
  renamingId: null,
};

const $ = (sel) => document.querySelector(sel);

/* ────────────────────────────── Toasts ─────────────────────────────────── */

/** Muestra un aviso flotante. type: 'info' | 'ok' | 'warn' | 'error'. */
function toast(msg, type, ms) {
  const box = $('#toasts');
  const el = document.createElement('div');
  el.className = 'toast ' + (type || 'info');
  el.textContent = msg;
  box.appendChild(el);
  requestAnimationFrame(() => el.classList.add('vis'));
  setTimeout(() => {
    el.classList.remove('vis');
    setTimeout(() => el.remove(), 350);
  }, ms || (type === 'error' ? 5200 : 3200));
}

/* ─────────────────────── Popover selector de color ─────────────────────── */

let popoverApply = null;   // callback (hex) del popover abierto

/** Abre el selector de color pegado al elemento `anchor`. */
function openColorPopover(anchor, currentHex, onApply) {
  const pop = $('#color-popover');
  popoverApply = onApply;

  // colores ya usados en el documento (edición rápida y consistente)
  const used = new Set();
  for (const f of INKORA.Model.state.faces2d) if (!f.deleted) used.add(f.color);
  for (const p of INKORA.Model.state.pieces) used.add(p.color);

  const swatches = (list) => list.map((c) =>
    `<button class="pop-swatch${U.isNearWhite(c) ? ' lite' : ''}" data-color="${c}"
       style="background:${c}" title="${c}"></button>`).join('');

  pop.innerHTML = `
    <div class="pop-title">Color</div>
    <div class="pop-grid">${swatches(PRESET_COLORS)}</div>
    ${used.size ? `<div class="pop-title">En uso</div>
    <div class="pop-grid">${swatches(Array.from(used))}</div>` : ''}
    <div class="pop-custom">
      <input type="color" id="pop-color-input" value="${U.normHex(currentHex) || '#ffffff'}">
      <span class="pop-hex">${U.normHex(currentHex) || ''}</span>
    </div>`;

  pop.classList.remove('hidden');
  const r = anchor.getBoundingClientRect();
  const pw = 236, ph = pop.offsetHeight || 260;
  pop.style.left = Math.max(8, Math.min(window.innerWidth - pw - 8, r.left - pw + r.width)) + 'px';
  pop.style.top = Math.max(8, Math.min(window.innerHeight - ph - 8, r.bottom + 6)) + 'px';

  pop.querySelectorAll('.pop-swatch').forEach((b) => {
    b.addEventListener('click', () => {
      if (popoverApply) popoverApply(b.dataset.color);
      closeColorPopover();
    });
  });
  const input = pop.querySelector('#pop-color-input');
  input.addEventListener('input', () => {
    pop.querySelector('.pop-hex').textContent = input.value;
    if (popoverApply) popoverApply(input.value);
  });
}

function closeColorPopover() {
  $('#color-popover').classList.add('hidden');
  popoverApply = null;
}

/** Abre el selector de color anclado a un punto de pantalla (x,y) en vez
 *  de un elemento — usado por el atajo "C" para abrirlo junto al cursor. */
function openColorPopoverAt(x, y, currentHex, onApply) {
  openColorPopover({ getBoundingClientRect: () => ({ left: x, right: x, top: y, bottom: y, width: 0 }) },
    currentHex, onApply);
}

/* ─────────────────────── Lista de elementos ────────────────────────────── */

/** Fila HTML de un elemento (cara 2D o pieza). */
function itemRowHtml(item, kind, selected) {
  const isPiece = kind === 'piece';
  const badge = isPiece
    ? `3D · ${U.fmt(item.height)}mm`
    : (item.kind === 'interior' ? 'interior' : '2D');
  const eye = item.visible ? '●' : '○';
  const swClass = U.isNearWhite(item.color) ? 'swatch lite' : 'swatch';
  return `
    <div class="elem-row${selected ? ' sel' : ''}${item.visible ? '' : ' dimmed'}" data-id="${item.id}" data-kind="${kind}">
      <button class="${swClass}" data-act="color" style="background:${item.color}" title="Cambiar color"></button>
      <span class="elem-name" data-act="name" title="Doble clic para renombrar">${U.escapeHtml(item.name)}</span>
      <span class="elem-badge">${badge}</span>
      <button class="elem-eye" data-act="eye" title="Mostrar / ocultar">${eye}</button>
    </div>`;
}

/** Re-dibuja la lista completa de elementos y grupos. */
function renderList() {
  const M = INKORA.Model;
  const state = M.state;
  const box = $('#elem-list');

  const selFaces = state.selection.faces2d;
  const selPieces = state.selection.pieceFaces;

  // elementos listables: caras activas u ocultas (no borradas/extruidas) y piezas
  const faceItems = state.faces2d.filter((f) => !f.deleted && !f.extrudedPieceId);
  const pieceItems = state.pieces;
  const inGroup = new Set();
  for (const g of state.groups) for (const id of g.memberIds) inGroup.add(id);

  let html = '';

  // ── grupos ──
  for (const g of state.groups) {
    const collapsed = uiState.collapsedGroups.has(g.id);
    const members = g.memberIds
      .map((id) => {
        const p = M.getPiece(id);
        if (p) return { item: p, kind: 'piece', sel: selPieces.has(id) };
        const f = M.getFace(id);
        if (f && !f.deleted && !f.extrudedPieceId) return { item: f, kind: 'face', sel: selFaces.has(id) };
        return null;
      })
      .filter(Boolean);
    if (!members.length) continue;
    html += `
      <div class="group-head" data-gid="${g.id}">
        <button class="group-caret" data-act="collapse">${collapsed ? '▸' : '▾'}</button>
        <span class="group-name" data-act="gname" title="Doble clic para renombrar">${U.escapeHtml(g.name)}</span>
        <span class="elem-badge">${members.length}</span>
        <button class="group-ungroup" data-act="ungroup" title="Desagrupar">⨯</button>
      </div>`;
    if (!collapsed) {
      html += '<div class="group-body">';
      for (const m of members) html += itemRowHtml(m.item, m.kind, m.sel);
      html += '</div>';
    }
  }

  // ── sueltos: piezas primero (lo más reciente arriba), luego caras 2D ──
  for (const p of [...pieceItems].reverse()) {
    if (!inGroup.has(p.id)) html += itemRowHtml(p, 'piece', selPieces.has(p.id));
  }
  for (const f of faceItems) {
    if (!inGroup.has(f.id)) html += itemRowHtml(f, 'face', selFaces.has(f.id));
  }

  box.innerHTML = html || '<div class="list-empty">Importá un DXF para empezar<br>(Ctrl+I o arrastralo acá)</div>';
  $('#elem-count').textContent = faceItems.length + pieceItems.length || '';
}

/** Convierte el nombre de un elemento en un input de renombrado inline. */
function startRename(rowEl, id) {
  const span = rowEl.querySelector('[data-act="name"], [data-act="gname"]');
  if (!span) return;
  const old = span.textContent;
  uiState.renamingId = id;
  const input = document.createElement('input');
  input.className = 'rename-input';
  input.value = old;
  span.replaceWith(input);
  input.focus();
  input.select();
  const commit = () => {
    uiState.renamingId = null;
    INKORA.Model.renameItem(id, input.value || old);
    refresh();  // por si el nombre no cambió (Model no emite en ese caso)
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') commit();
    if (e.key === 'Escape') { uiState.renamingId = null; refresh(); }
  });
  input.addEventListener('blur', commit);
}

/* ─────────────────────────── Refresh global ────────────────────────────── */

/** Re-dibuja todo lo dinámico de la interfaz. */
function refresh() {
  const M = INKORA.Model;
  const H = INKORA.History;
  const state = M.state;
  const info = M.selectionInfo();
  const hasDoc = state.contours.length > 0;

  /* botones de la barra */
  $('#btn-export').disabled = !state.pieces.some((p) => p.visible);
  $('#btn-undo').disabled = !H.canUndo();
  $('#btn-redo').disabled = !H.canRedo();
  $('#btn-undo').title = H.canUndo() ? 'Deshacer: ' + H.undoLabel() + ' (Ctrl+Z)' : 'Deshacer (Ctrl+Z)';
  $('#btn-redo').title = H.canRedo() ? 'Rehacer: ' + H.redoLabel() + ' (Ctrl+Shift+Z)' : 'Rehacer (Ctrl+Shift+Z)';
  $('#history-label').textContent = H.positionLabel();

  /* tarjeta de extrusión */
  $('#btn-extrude').disabled = info.empty;

  /* tarjeta de selección */
  $('#sel-count').textContent = info.empty ? 'nada' :
    [info.faces2d ? info.faces2d + ' cara(s) 2D' : '', info.pieces ? info.pieces + ' pieza(s)' : '']
      .filter(Boolean).join(' + ');

  const pieceProps = $('#piece-props');
  if (info.pieces > 0) {
    pieceProps.classList.remove('hidden');
    // si todas las piezas seleccionadas comparten altura, mostrarla
    const hs = Array.from(state.selection.pieceFaces.keys())
      .map((id) => M.getPiece(id)).filter(Boolean).map((p) => p.height);
    const same = hs.length && hs.every((h) => h === hs[0]);
    const input = $('#piece-height');
    if (document.activeElement !== input) input.value = same ? hs[0] : '';
    input.placeholder = same ? '' : 'varias';
  } else {
    pieceProps.classList.add('hidden');
  }

  /* lista + estado vacío del viewport */
  renderList();
  $('#drop-hint').classList.toggle('hidden', hasDoc);

  /* barra de estado */
  if (hasDoc) {
    const nSolid = state.faces2d.filter((f) => f.kind === 'solid' && !f.deleted).length;
    const nInt = state.faces2d.filter((f) => f.kind === 'interior' && !f.deleted).length;
    $('#status-doc').textContent =
      `${state.docName} — ${nSolid} figura(s), ${nInt} interior(es), ${state.pieces.length} pieza(s)`;
  } else {
    $('#status-doc').textContent = 'Sin documento';
  }
}

/* ─────────────────────────── Cableado inicial ──────────────────────────── */

/** Conecta todos los controles. Llamar una sola vez al arrancar. */
function initUI() {
  const M = INKORA.Model;

  /* barra superior */
  $('#btn-import').addEventListener('click', () => $('#file-input').click());
  $('#btn-undo').addEventListener('click', () => INKORA.History.undo());
  $('#btn-redo').addEventListener('click', () => INKORA.History.redo());
  $('#btn-help').addEventListener('click', () => $('#modal-help').classList.toggle('hidden'));
  $('#modal-help').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) $('#modal-help').classList.add('hidden');
  });
  $('#btn-export').addEventListener('click', doExport);

  /* extrusión */
  $('#btn-extrude').addEventListener('click', doExtrude);
  document.querySelectorAll('.mode-btn').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll('.mode-btn').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
    });
  });

  /* selección rápida */
  $('#btn-sel-all').addEventListener('click', () => M.selectAll());
  $('#btn-sel-none').addEventListener('click', () => M.clearSelection());
  $('#btn-sel-invert').addEventListener('click', () => M.invertSelection());
  $('#btn-sel-top').addEventListener('click', () => M.selectAllPieceFaces('top'));
  $('#btn-sel-bottom').addEventListener('click', () => M.selectAllPieceFaces('bottom'));

  /* propiedades de piezas seleccionadas */
  $('#piece-height').addEventListener('change', () => {
    const r = M.setHeightForSelection($('#piece-height').value);
    if (r && r.msg) toast(r.msg, 'warn');
  });
  $('#btn-sel-color').addEventListener('click', (e) => {
    openColorPopover(e.currentTarget, null, (hex) => M.setColorForSelection(hex));
  });
  $('#btn-duplicate').addEventListener('click', () => {
    const r = M.duplicateSelection();
    if (!r.ok && r.msg) toast(r.msg, 'warn');
  });
  $('#btn-isolate').addEventListener('click', () => {
    const r = M.isolateSelection();
    if (!r.ok && r.msg) toast(r.msg, 'info');
  });

  /* agrupar / desagrupar */
  $('#btn-group').addEventListener('click', () => {
    const r = M.groupSelection();
    if (!r.ok && r.msg) toast(r.msg, 'warn');
  });
  $('#btn-ungroup').addEventListener('click', () => M.ungroupSelection());

  /* lista de elementos: delegación de eventos */
  const list = $('#elem-list');

  list.addEventListener('click', (e) => {
    const groupHead = e.target.closest('.group-head');
    if (groupHead) {
      const gid = groupHead.dataset.gid;
      const act = e.target.dataset.act;
      if (act === 'collapse') {
        if (uiState.collapsedGroups.has(gid)) uiState.collapsedGroups.delete(gid);
        else uiState.collapsedGroups.add(gid);
        renderList();
      } else if (act === 'ungroup') {
        M.ungroup(gid);
      } else {
        M.selectGroup(gid, e.shiftKey ? 'add' : 'set');
      }
      return;
    }
    const row = e.target.closest('.elem-row');
    if (!row) return;
    const id = row.dataset.id;
    const act = e.target.dataset.act;

    if (act === 'color') {
      const item = M.getPiece(id) || M.getFace(id);
      const selInfo = M.selectionInfo();
      const isSelected = M.state.selection.pieceFaces.has(id) || M.state.selection.faces2d.has(id);
      openColorPopover(e.target, item ? item.color : null, (hex) => {
        // si el elemento es parte de una selección múltiple, colorear todo
        if (isSelected && selInfo.total > 1) M.setColorForSelection(hex);
        else M.setItemColor(id, hex);
      });
      return;
    }
    if (act === 'eye') { M.toggleVisible(id); return; }
    const mode = e.shiftKey ? 'add' : (e.ctrlKey || e.metaKey) ? 'toggle' : 'set';
    M.selectItem(id, mode);
  });

  list.addEventListener('dblclick', (e) => {
    const head = e.target.closest('.group-head');
    if (head && e.target.dataset.act === 'gname') { startRename(head, head.dataset.gid); return; }
    const row = e.target.closest('.elem-row');
    if (row && e.target.dataset.act === 'name') startRename(row, row.dataset.id);
  });

  /* cerrar popover al clickear afuera */
  document.addEventListener('pointerdown', (e) => {
    const pop = $('#color-popover');
    if (!pop.classList.contains('hidden') &&
        !pop.contains(e.target) &&
        !e.target.closest('[data-act="color"], #btn-sel-color')) {
      closeColorPopover();
    }
  });

  /* refrescar ante cualquier cambio del modelo o del historial */
  M.events.on('change', () => {
    INKORA.SceneBuilder.rebuild();
    INKORA.Viewport.requestRender();
    refresh();
  });
  INKORA.History.events.on('change', refresh);

  refresh();
}

/* ─────────────────────── Acciones compartidas ──────────────────────────── */

/** Extruye la selección con los parámetros de la tarjeta. */
function doExtrude() {
  const height = parseFloat($('#extrude-height').value);
  const mode = document.querySelector('.mode-btn.active').dataset.mode;
  const r = INKORA.Model.extrudeSelection({ height, mode });
  if (!r.ok) toast(r.msg, 'warn');
  else toast(`Extrusión lista: ${r.created} pieza(s) de ${U.fmt(height)} mm.`, 'ok');
}

/** Exporta el 3MF y lo descarga. */
function doExport() {
  const r = INKORA.Exporter.export3MF(INKORA.Model.state);
  if (!r.ok) { toast(r.msg, 'warn'); return; }
  for (const w of r.warnings) toast(w, 'warn');
  U.downloadBlob(r.filename, new Blob([r.bytes], { type: 'model/3mf' }));
  toast(`Exportado ${r.filename} — ${r.stats.objects} objeto(s), ${r.stats.triangles} triángulos.`, 'ok', 4200);
}

/** true si el usuario está escribiendo en un campo (bloquea atajos). */
function isTyping() {
  const a = document.activeElement;
  return a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable);
}

/** Renombra el primer elemento seleccionado (tecla F2). */
function renameSelected() {
  const M = INKORA.Model;
  const id = M.state.selection.pieceFaces.keys().next().value ||
             M.state.selection.faces2d.values().next().value;
  if (!id) { toast('Seleccioná un elemento para renombrar.', 'info'); return; }
  const row = document.querySelector(`.elem-row[data-id="${id}"]`);
  if (row) startRename(row, id);
}

/** Alterna el modo de extrusión (Separadas ⇄ Unidas). Tecla "O". */
function toggleExtrudeMode() {
  const buttons = document.querySelectorAll('.mode-btn');
  const active = document.querySelector('.mode-btn.active');
  const next = active === buttons[0] ? buttons[1] : buttons[0];
  buttons.forEach((b) => b.classList.remove('active'));
  next.classList.add('active');
  toast('Modo de extrusión: ' + (next.dataset.mode === 'merged' ? 'Objeto unido' : 'Objetos separados'), 'info', 1800);
}

/** Abre el color de la selección actual anclado al cursor. Tecla "C". */
function colorSelectionAtCursor() {
  const M = INKORA.Model;
  if (M.selectionInfo().empty) { toast('Seleccioná algo para cambiarle el color.', 'info'); return; }
  const { x, y } = INKORA.Viewport.lastMouse;
  openColorPopoverAt(x, y, null, (hex) => M.setColorForSelection(hex));
}

INKORA.UI = {
  initUI, refresh, toast, doExtrude, doExport, isTyping, renameSelected,
  closeColorPopover, toggleExtrudeMode, colorSelectionAtCursor,
};
})(typeof window !== 'undefined' ? window : globalThis);
