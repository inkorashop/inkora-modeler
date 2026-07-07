/* ============================================================================
   INKORA · main.js
   ----------------------------------------------------------------------------
   Punto de entrada: arranque de la aplicación, vías de importación y mapa
   completo de atajos de teclado.

   Vías de importación (todas terminan en importDxfText):
   · Ctrl+I / botón      — abrir un archivo .dxf
   · Arrastrar y soltar  — soltar el .dxf sobre la ventana
   · Ctrl+V              — pegar el DXF que la macro de CorelDRAW dejó
                           en el portapapeles (corel/INKORA-Corel.bas)

   Atajos:
   · Ctrl+I  importar          · Ctrl+Z  deshacer
   · Ctrl+V  pegar de Corel    · Ctrl+Shift+Z / Ctrl+Y  rehacer
   · Ctrl+S  exportar 3MF      · Ctrl+A  seleccionar todo
   · E       extruir           · Esc     deseleccionar / cerrar
   · Supr    eliminar          · Ctrl+1 / Ctrl+2  caras sup. / inf.
   · Ctrl+G  agrupar           · Ctrl+Shift+G  desagrupar
   · F       encuadrar         · F2  renombrar   · H  ocultar/mostrar
   · ?       ayuda de atajos
   ============================================================================ */
(function (global) {
'use strict';

const INKORA = global.INKORA = global.INKORA || {};
const U = INKORA.Utils;

/* ─────────────────────────── Importación ───────────────────────────────── */

/**
 * Importa un DXF desde texto (archivo o portapapeles).
 * @param {string} text  contenido DXF
 * @param {string} name  nombre del documento (sin extensión)
 */
function importDxfText(text, name) {
  let parsed;
  try {
    parsed = INKORA.DXF.parse(text);
  } catch (err) {
    INKORA.UI.toast('Error al leer el DXF: ' + err.message, 'error');
    return;
  }
  if (!parsed.contours.length) {
    INKORA.UI.toast('El DXF no contiene contornos cerrados utilizables.', 'error');
    return;
  }
  const warnings = INKORA.Model.newDocument(parsed, name);
  for (const w of warnings) INKORA.UI.toast(w, 'warn', 4500);
  INKORA.Viewport.frame();

  const s = INKORA.Model.state;
  const nInt = s.faces2d.filter((f) => f.kind === 'interior').length;
  INKORA.UI.toast(
    `Importado: ${s.faces2d.length} cara(s)` + (nInt ? ` (${nInt} interior(es) detectado(s))` : '') + '.',
    'ok'
  );
}

/** ¿El texto parece un DXF? (para validar lo pegado con Ctrl+V) */
function looksLikeDxf(text) {
  return typeof text === 'string' &&
         text.indexOf('SECTION') >= 0 && text.indexOf('ENTITIES') >= 0;
}

/** Importa un objeto File (del input o de arrastrar y soltar). */
async function importFile(file) {
  if (!file) return;
  const name = file.name.replace(/\.[^.]+$/, '');
  try {
    const text = await U.readFileAsText(file);
    if (!looksLikeDxf(text)) {
      INKORA.UI.toast('El archivo no parece un DXF válido.', 'error');
      return;
    }
    importDxfText(text, name);
  } catch (err) {
    INKORA.UI.toast('No se pudo leer el archivo: ' + err.message, 'error');
  }
}

function wireImports() {
  /* input de archivo (Ctrl+I / botón Importar) */
  const fileInput = document.querySelector('#file-input');
  fileInput.addEventListener('change', () => {
    importFile(fileInput.files[0]);
    fileInput.value = '';           // permitir re-importar el mismo archivo
  });

  /* arrastrar y soltar sobre toda la ventana */
  window.addEventListener('dragover', (e) => {
    e.preventDefault();
    document.body.classList.add('dragging');
  });
  window.addEventListener('dragleave', (e) => {
    if (!e.relatedTarget) document.body.classList.remove('dragging');
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    document.body.classList.remove('dragging');
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) importFile(file);
  });

  /* pegar desde CorelDRAW (la macro deja el DXF como texto) */
  window.addEventListener('paste', (e) => {
    if (INKORA.UI.isTyping()) return;
    const dt = e.clipboardData;
    if (!dt) return;
    if (dt.files && dt.files.length) { importFile(dt.files[0]); return; }
    const text = dt.getData('text/plain');
    if (looksLikeDxf(text)) {
      e.preventDefault();
      importDxfText(text, INKORA.Model.state.docName || 'corel');
    } else if (text) {
      INKORA.UI.toast('El portapapeles no contiene un DXF. Usá la macro INKORA en CorelDRAW.', 'warn');
    }
  });
}

/* ─────────────────────── Atajos de teclado ───────────────────────────────
   Tabla idéntica a los atajos por defecto de la versión anterior de INKORA
   (el mismo mapeo tecla→acción, para no reentrenar la memoria muscular):

     f            Encuadrar escena          Ctrl+Z          Deshacer
     a            Seleccionar todo          Ctrl+Shift+Z    Rehacer
     Escape       Deseleccionar todo        Ctrl+G          Agrupar selección
     i            Invertir selección        Ctrl+U          Desagrupar
     Ctrl+1       Caras superiores *        Ctrl+I          Importar DXF
     Ctrl+2       Caras inferiores *        Ctrl+E          Exportar 3MF
     e            Extruir selección         Ctrl+D          Duplicar pieza
     o            Alternar modo extrusión   Alt+I           Aislar pieza
     c            Color de selección        Delete          Eliminar selección
     h            Ocultar / mostrar

   * Ctrl+1/Ctrl+2 están reservados por TODOS los navegadores (Chrome, Edge,
     Firefox) para cambiar de pestaña — la página nunca recibe ese evento,
     ni con preventDefault(). Quedan definidos igual que en la versión
     original por fidelidad, pero además "T" y "B" (sin Ctrl) hacen
     exactamente lo mismo y sí funcionan siempre: son la forma confiable de
     usar ese atajo.

   "Abrir/Guardar proyecto" (Ctrl+O / Ctrl+S en la versión original) no
   tienen equivalente: esta reescritura no tiene formato de proyecto propio,
   solo importar DXF → extruir → exportar 3MF. */

function wireKeyboard() {
  const M = INKORA.Model;
  const H = INKORA.History;
  const UIx = INKORA.UI;

  window.addEventListener('keydown', (e) => {
    /* nunca robar teclas mientras se escribe en un campo */
    if (UIx.isTyping()) return;

    const ctrl = e.ctrlKey || e.metaKey;
    const alt = e.altKey;
    const k = e.key.toLowerCase();

    /* ── Alt ── */
    if (alt && !ctrl) {
      if (k === 'i') {
        e.preventDefault();
        const r = M.isolateSelection();
        if (!r.ok && r.msg) UIx.toast(r.msg, 'info');
      }
      return;
    }

    /* ── Ctrl ── */
    if (ctrl) {
      switch (k) {
        case 'i': e.preventDefault(); document.querySelector('#file-input').click(); return;
        case 'e': e.preventDefault(); UIx.doExport(); return;
        case 'z': e.preventDefault(); e.shiftKey ? H.redo() : H.undo(); return;
        case 'a': e.preventDefault(); M.selectAll(); return; // alias de compatibilidad (el original usa "a" sin Ctrl)
        case 'g': e.preventDefault();
          { const r = M.groupSelection(); if (!r.ok && r.msg) UIx.toast(r.msg, 'warn'); }
          return;
        case 'u': e.preventDefault(); M.ungroupSelection(); return;
        case 'd': e.preventDefault();
          { const r = M.duplicateSelection(); if (!r.ok && r.msg) UIx.toast(r.msg, 'warn'); }
          return;
        case '1': e.preventDefault(); M.selectAllPieceFaces('top'); return;    // ver nota: no llega en navegador real
        case '2': e.preventDefault(); M.selectAllPieceFaces('bottom'); return; // usar "B" en su lugar
        // Ctrl+V lo maneja el evento 'paste'
      }
      return;
    }

    /* ── sin modificadores ── */
    switch (e.key) {
      case 'Escape':
        UIx.closeColorPopover();
        document.querySelector('#modal-help').classList.add('hidden');
        M.clearSelection();
        return;
      case 'Delete':
      case 'Backspace': {
        e.preventDefault();
        const r = M.deleteSelection();
        if (!r.ok && r.msg) UIx.toast(r.msg, 'info');
        return;
      }
      case 'F2': e.preventDefault(); UIx.renameSelected(); return;
      case '?': document.querySelector('#modal-help').classList.toggle('hidden'); return;
    }
    switch (k) {
      case 'a': e.preventDefault(); M.selectAll(); return;
      case 'e': e.preventDefault(); UIx.doExtrude(); return;
      case 'f': e.preventDefault(); INKORA.Viewport.frame(); return;
      case 'i': e.preventDefault(); M.invertSelection(); return;
      case 'o': e.preventDefault(); UIx.toggleExtrudeMode(); return;
      case 'c': e.preventDefault(); UIx.colorSelectionAtCursor(); return;
      case 't': e.preventDefault(); M.selectAllPieceFaces('top'); return;    // equivalente confiable de Ctrl+1
      case 'b': e.preventDefault(); M.selectAllPieceFaces('bottom'); return; // equivalente confiable de Ctrl+2
      case 'h': {
        e.preventDefault();
        const ids = [...M.state.selection.pieceFaces.keys(), ...M.state.selection.faces2d];
        if (!ids.length) { UIx.toast('Seleccioná algo para ocultar/mostrar.', 'info'); return; }
        for (const id of ids) M.toggleVisible(id);
        return;
      }
    }
  });
}

/* ────────────────────────────── Arranque ───────────────────────────────── */

function boot() {
  INKORA.Viewport.init(document.querySelector('#viewport'));
  INKORA.UI.initUI();
  wireImports();
  wireKeyboard();
  INKORA.Viewport.requestRender();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}

INKORA.App = { importDxfText, importFile };
})(typeof window !== 'undefined' ? window : globalThis);
