/* ============================================================================
   INKORA · history.js
   ----------------------------------------------------------------------------
   Historial de deshacer/rehacer por SNAPSHOTS completos del estado dinámico.

   El programa anterior guardaba deltas incrementales y el historial se
   corrompía (bug reportado de Ctrl+Z / Ctrl+Shift+Z). Este módulo captura
   el estado entero después de cada operación: deshacer y rehacer son una
   simple restauración, imposible de desincronizar.

   · push(label)  — el modelo lo llama después de CADA mutación real
   · undo()/redo()— restauran el snapshot anterior/siguiente
   · reset(label) — arranca el historial con el estado recién importado
   Eventos: 'change' (para refrescar los botones de la barra).
   ============================================================================ */
(function (global) {
'use strict';

const INKORA = global.INKORA = global.INKORA || {};
const U = INKORA.Utils;

const MAX_ENTRIES = 100;   // tope de memoria del historial

let stack = [];            // [{ label, snap }]
let index = -1;            // posición actual dentro de stack

const events = U.Emitter();

/** Reinicia el historial con el estado actual como línea base. */
function reset(label) {
  stack = [{ label: label || 'Inicio', snap: INKORA.Model.snapshot() }];
  index = 0;
  events.emit('change');
}

/** Registra el estado actual como nueva entrada (descarta el "futuro"). */
function push(label) {
  if (index < stack.length - 1) stack = stack.slice(0, index + 1);
  stack.push({ label: label || 'Cambio', snap: INKORA.Model.snapshot() });
  if (stack.length > MAX_ENTRIES) stack.shift();
  index = stack.length - 1;
  events.emit('change');
}

/** Deshace la última operación (si hay). */
function undo() {
  if (!canUndo()) return false;
  index--;
  INKORA.Model.restore(stack[index].snap);
  events.emit('change');
  return true;
}

/** Rehace la operación deshecha (si hay). */
function redo() {
  if (!canRedo()) return false;
  index++;
  INKORA.Model.restore(stack[index].snap);
  events.emit('change');
  return true;
}

function canUndo() { return index > 0; }
function canRedo() { return index >= 0 && index < stack.length - 1; }

/** Etiqueta de lo que se va a deshacer/rehacer (para tooltips de la UI). */
function undoLabel() { return canUndo() ? stack[index].label : null; }
function redoLabel() { return canRedo() ? stack[index + 1].label : null; }

/** Posición legible, ej: "3/7". */
function positionLabel() {
  return stack.length ? (index + 1) + '/' + stack.length : '—';
}

INKORA.History = {
  events, reset, push, undo, redo,
  canUndo, canRedo, undoLabel, redoLabel, positionLabel,
};
})(typeof window !== 'undefined' ? window : globalThis);
