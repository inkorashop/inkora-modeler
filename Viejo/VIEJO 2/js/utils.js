/* ============================================================================
   INKORA · utils.js
   ----------------------------------------------------------------------------
   Utilidades compartidas por todos los módulos:
   - Geometría 2D sobre polígonos (arrays de puntos [x, y])
   - Colores (hex, tabla ACI de AutoCAD, contraste)
   - Bus de eventos mínimo (Emitter)
   - Helpers de archivos y varios
   Todos los módulos viven bajo el espacio global `INKORA`.
   ============================================================================ */
(function (global) {
'use strict';

const INKORA = global.INKORA = global.INKORA || {};
const Utils = {};

/* ────────────────────────────── IDs únicos ────────────────────────────── */

let _idCounter = 1;

/** Genera un id único legible, ej: "pieza_12". */
Utils.newId = function (prefix) {
  return (prefix || 'id') + '_' + (_idCounter++);
};

/** Ajusta el contador de ids (usado al restaurar snapshots del historial). */
Utils.bumpIdCounter = function (n) {
  if (typeof n === 'number' && n > _idCounter) _idCounter = n;
};
Utils.idCounter = function () { return _idCounter; };

/* ────────────────────────────── Números ───────────────────────────────── */

/** Limita v al rango [min, max]. */
Utils.clamp = function (v, min, max) {
  return v < min ? min : (v > max ? max : v);
};

/** Redondea a `dec` decimales (por defecto 4). */
Utils.round = function (v, dec) {
  const f = Math.pow(10, dec == null ? 4 : dec);
  return Math.round(v * f) / f;
};

/** Formatea un número para mostrar (sin ceros sobrantes). */
Utils.fmt = function (v, dec) {
  return String(Utils.round(v, dec == null ? 2 : dec));
};

/* ─────────────────────── Geometría 2D (polígonos) ─────────────────────────
   Un "polígono" es un array de puntos [[x,y], [x,y], ...] SIN repetir el
   punto inicial al final (anillo abierto implícitamente cerrado).
   ─────────────────────────────────────────────────────────────────────── */

/** Área con signo (fórmula del cordón). >0 = antihorario (CCW). */
Utils.signedArea = function (pts) {
  let s = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
};

/** Área absoluta del polígono. */
Utils.polygonArea = function (pts) {
  return Math.abs(Utils.signedArea(pts));
};

/** Perímetro (longitud del contorno cerrado). */
Utils.polygonPerimeter = function (pts) {
  let p = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    p += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return p;
};

/**
 * Compacidad de un polígono: 4π·Área / Perímetro².
 * 1.0 = círculo perfecto; baja a medida que la forma es más alargada,
 * angulosa o irregular (una letra típica ronda 0.2–0.5).
 */
Utils.compactness = function (pts) {
  const area = Utils.polygonArea(pts);
  const perim = Utils.polygonPerimeter(pts);
  return perim > 1e-9 ? (4 * Math.PI * area) / (perim * perim) : 0;
};

/** true si el polígono está en sentido antihorario (CCW). */
Utils.isCCW = function (pts) {
  return Utils.signedArea(pts) > 0;
};

/** Devuelve una copia del polígono con la orientación pedida. */
Utils.withWinding = function (pts, ccw) {
  const isCCW = Utils.isCCW(pts);
  return (isCCW === !!ccw) ? pts.slice() : pts.slice().reverse();
};

/** Distancia euclidiana al cuadrado entre dos puntos. */
Utils.dist2 = function (a, b) {
  const dx = a[0] - b[0], dy = a[1] - b[1];
  return dx * dx + dy * dy;
};

/**
 * Limpia un polígono: elimina puntos consecutivos duplicados (según `tol`)
 * y el punto de cierre repetido. Devuelve un array nuevo.
 */
Utils.cleanPolygon = function (pts, tol) {
  const t2 = (tol == null ? 1e-6 : tol) ** 2;
  const out = [];
  for (const p of pts) {
    if (!out.length || Utils.dist2(out[out.length - 1], p) > t2) out.push([p[0], p[1]]);
  }
  // quitar el punto de cierre si coincide con el inicial
  while (out.length > 1 && Utils.dist2(out[0], out[out.length - 1]) <= t2) out.pop();
  return out;
};

/** Bounding box: {minX, minY, maxX, maxY, w, h, cx, cy}. */
Utils.bboxOf = function (pts) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p[0] < minX) minX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] > maxY) maxY = p[1];
  }
  return {
    minX, minY, maxX, maxY,
    w: maxX - minX, h: maxY - minY,
    cx: (minX + maxX) / 2, cy: (minY + maxY) / 2,
  };
};

/** Une varios bbox en uno. */
Utils.bboxUnion = function (boxes) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const b of boxes) {
    if (!b) continue;
    if (b.minX < minX) minX = b.minX;
    if (b.minY < minY) minY = b.minY;
    if (b.maxX > maxX) maxX = b.maxX;
    if (b.maxY > maxY) maxY = b.maxY;
  }
  if (minX === Infinity) return null;
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
};

/** true si el bbox `outer` contiene al bbox `inner` (con tolerancia). */
Utils.bboxContainsBbox = function (outer, inner, tol) {
  const t = tol == null ? 1e-6 : tol;
  return outer.minX <= inner.minX + t && outer.minY <= inner.minY + t &&
         outer.maxX >= inner.maxX - t && outer.maxY >= inner.maxY - t;
};

/**
 * Test punto-en-polígono por conteo de cruces (ray casting).
 * Robusto para polígonos no convexos. Bordes cuentan como "dentro".
 */
Utils.pointInPolygon = function (pt, pts) {
  const x = pt[0], y = pt[1];
  let inside = false;
  for (let i = 0, n = pts.length, j = n - 1; i < n; j = i++) {
    const xi = pts[i][0], yi = pts[i][1];
    const xj = pts[j][0], yj = pts[j][1];
    if ((yi > y) !== (yj > y)) {
      const xCross = (xj - xi) * (y - yi) / (yj - yi) + xi;
      if (x < xCross) inside = !inside;
    }
  }
  return inside;
};

/**
 * Punto representativo GARANTIZADO dentro de la región (outer − holes).
 * 1) Prueba el centroide (rápido y suele funcionar).
 * 2) Si falla, hace un barrido horizontal por varias alturas y toma el punto
 *    medio del tramo interior más ancho (paridad de cruces contra todos los
 *    anillos: outer + holes). Es el mismo principio que usa "polylabel" pero
 *    simplificado, suficiente para contornos de llaveros.
 * Devuelve [x, y] o null si la región es degenerada.
 */
Utils.innerPoint = function (outer, holes) {
  holes = holes || [];
  const inRegion = (p) => {
    if (!Utils.pointInPolygon(p, outer)) return false;
    for (const h of holes) if (Utils.pointInPolygon(p, h)) return false;
    return true;
  };

  // 1) centroide del anillo exterior
  let cx = 0, cy = 0;
  for (const p of outer) { cx += p[0]; cy += p[1]; }
  const centroid = [cx / outer.length, cy / outer.length];
  if (inRegion(centroid)) return centroid;

  // 2) barrido por scanlines: paridad de cruces contra todos los anillos
  const rings = [outer].concat(holes);
  const bb = Utils.bboxOf(outer);
  const STEPS = 24;
  let best = null, bestWidth = -1;

  for (let s = 1; s < STEPS; s++) {
    const y = bb.minY + (bb.h * s) / STEPS;
    const xs = [];
    for (const ring of rings) {
      for (let i = 0, n = ring.length, j = n - 1; i < n; j = i++) {
        const yi = ring[i][1], yj = ring[j][1];
        if ((yi > y) !== (yj > y)) {
          xs.push(ring[j][0] + (ring[i][0] - ring[j][0]) * (y - yj) / (yi - yj));
        }
      }
    }
    xs.sort((a, b) => a - b);
    // pares consecutivos = tramos interiores (paridad par-impar)
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const w = xs[k + 1] - xs[k];
      if (w > bestWidth) {
        const mid = [(xs[k] + xs[k + 1]) / 2, y];
        if (inRegion(mid)) { bestWidth = w; best = mid; }
      }
    }
  }
  return best;
};

/* ─────────────────────────────── Colores ──────────────────────────────── */

/**
 * Normaliza un color a "#rrggbb" en minúsculas.
 * Acepta "#rgb", "#rrggbb", "rgb(r,g,b)" o un entero 0xRRGGBB.
 * Devuelve null si no puede interpretarlo.
 */
Utils.normHex = function (c) {
  if (c == null) return null;
  if (typeof c === 'number' && isFinite(c)) {
    const n = Math.max(0, Math.min(0xFFFFFF, Math.floor(c)));
    return '#' + n.toString(16).padStart(6, '0');
  }
  let s = String(c).trim().toLowerCase();
  let m = s.match(/^#?([0-9a-f]{6})$/);
  if (m) return '#' + m[1];
  m = s.match(/^#?([0-9a-f]{3})$/);
  if (m) return '#' + m[1].split('').map(ch => ch + ch).join('');
  m = s.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (m) return Utils.rgbToHex(+m[1], +m[2], +m[3]);
  return null;
};

Utils.rgbToHex = function (r, g, b) {
  const h = (v) => Utils.clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0');
  return '#' + h(r) + h(g) + h(b);
};

Utils.hexToRgb = function (hex) {
  const h = Utils.normHex(hex);
  if (!h) return null;
  return {
    r: parseInt(h.slice(1, 3), 16),
    g: parseInt(h.slice(3, 5), 16),
    b: parseInt(h.slice(5, 7), 16),
  };
};

/** Luminancia relativa aproximada (0..1). */
Utils.luminance = function (hex) {
  const c = Utils.hexToRgb(hex);
  if (!c) return 0;
  return (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255;
};

/** Color de texto legible (navy u blanco) sobre un fondo dado. */
Utils.contrastText = function (hex) {
  return Utils.luminance(hex) > 0.55 ? '#12294b' : '#ffffff';
};

/** true si el color es blanco o casi blanco (para dibujar borde en la UI). */
Utils.isNearWhite = function (hex) {
  return Utils.luminance(hex) > 0.92;
};

/* Tabla de colores ACI (AutoCAD Color Index).
   - Índices 1..9 y 250..255: valores exactos estándar.
   - Índices 10..249: generados con la fórmula HSV clásica de AutoCAD
     (24 tonos × 10 variantes de brillo/saturación). La precisión exacta
     no es crítica: CorelDRAW moderno exporta color verdadero (código 420),
     y la tabla solo actúa de respaldo.
   - IMPORTANTE: el índice 7 se trata SIEMPRE como blanco puro (#ffffff),
     que era uno de los bugs del programa anterior. */
const ACI_EXACT = {
  1: '#ff0000', 2: '#ffff00', 3: '#00ff00', 4: '#00ffff', 5: '#0000ff',
  6: '#ff00ff', 7: '#ffffff', 8: '#414141', 9: '#808080',
  250: '#333333', 251: '#5b5b5b', 252: '#848484',
  253: '#adadad', 254: '#d6d6d6', 255: '#ffffff',
};

function hsvToHex(h, s, v) {
  const i = Math.floor(h / 60) % 6;
  const f = h / 60 - Math.floor(h / 60);
  const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  const rgb = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i];
  return Utils.rgbToHex(rgb[0] * 255, rgb[1] * 255, rgb[2] * 255);
}

/** Convierte un índice ACI (1..255) a "#rrggbb". */
Utils.aciToHex = function (idx) {
  idx = Math.abs(Math.floor(idx));
  if (ACI_EXACT[idx]) return ACI_EXACT[idx];
  if (idx < 10 || idx > 249) return '#000000';
  const group = Math.floor((idx - 10) / 10);    // 24 grupos de tono
  const shade = (idx - 10) % 10;                // 10 variantes por tono
  const hue = group * 15;                        // 0..345 grados
  const vLevels = [1.0, 0.8, 0.6, 0.5, 0.3];
  const v = vLevels[Math.floor(shade / 2)];
  const s = (shade % 2 === 0) ? 1.0 : 0.45;      // par = saturado, impar = pastel
  return hsvToHex(hue, s, v);
};

/* ─────────────────────────── Bus de eventos ───────────────────────────── */

/** Emitter mínimo: on(evt, fn), off(evt, fn), emit(evt, ...args). */
Utils.Emitter = function () {
  const map = new Map();
  return {
    on(evt, fn) {
      if (!map.has(evt)) map.set(evt, new Set());
      map.get(evt).add(fn);
      return fn;
    },
    off(evt, fn) {
      const set = map.get(evt);
      if (set) set.delete(fn);
    },
    emit(evt, ...args) {
      const set = map.get(evt);
      if (set) for (const fn of Array.from(set)) fn(...args);
    },
  };
};

/* ──────────────────────────── Archivos / DOM ──────────────────────────── */

/** Descarga un Blob con el nombre dado (crea un <a> temporal). */
Utils.downloadBlob = function (filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
};

/** Lee un File como texto (Promise<string>). */
Utils.readFileAsText = function (file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error || new Error('No se pudo leer el archivo'));
    r.readAsText(file);
  });
};

/** Escapa texto para insertarlo en HTML. */
Utils.escapeHtml = function (s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
};

/** Escapa texto para atributos/nodos XML. */
Utils.escapeXml = function (s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  }[ch]));
};

/** Clon profundo por JSON (suficiente: los snapshots son datos planos). */
Utils.deepClone = function (obj) {
  return JSON.parse(JSON.stringify(obj));
};

/** Marca de tiempo local "YYYY-MM-DD HH:MM". */
Utils.nowStamp = function () {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

INKORA.Utils = Utils;
})(typeof window !== 'undefined' ? window : globalThis);
