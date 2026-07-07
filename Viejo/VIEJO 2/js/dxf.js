/* ============================================================================
   INKORA · dxf.js
   ----------------------------------------------------------------------------
   Parser de archivos DXF (ASCII) orientado a vectores 2D de CorelDRAW /
   AutoCAD. Convierte el archivo en una lista de contornos cerrados:

     { pts: [[x,y],...], color: '#rrggbb'|null, layer: 'nombre' }

   Soporta:
   - LWPOLYLINE / POLYLINE+VERTEX (con arcos "bulge")
   - LINE, ARC, CIRCLE, ELLIPSE
   - SPLINE (NURBS racional con puntos de control; respaldo por fit points)
   - Colores: código 420 (color verdadero), 62 (índice ACI) y BYLAYER
     (tabla de capas). El índice ACI 7 se interpreta SIEMPRE como blanco puro.
   - Unidades vía $INSUNITS (todo se normaliza a milímetros)
   - Encadenado de segmentos sueltos (LINE/ARC/splines abiertas) en anillos
     cerrados, con tolerancia adaptativa.

   Entrada:  texto DXF completo.
   Salida:   { contours, warnings, stats }
   ============================================================================ */
(function (global) {
'use strict';

const INKORA = global.INKORA = global.INKORA || {};
const U = INKORA.Utils;

/* Resolución de curvas: segmentos por vuelta completa para arcos/círculos.
   64 por vuelta ≈ error de cuerda < 0.05 mm en un círculo de 40 mm. */
const ARC_SEGS_PER_TURN = 64;
const SPLINE_SAMPLES_PER_SPAN = 8;

/* ───────────────────────────── Tokenizador ─────────────────────────────── */

/**
 * Convierte el texto DXF en una lista de pares {code, value}.
 * El DXF ASCII alterna una línea con el código de grupo y otra con el valor.
 */
function tokenize(text) {
  const lines = text.split(/\r\n|\r|\n/);
  const pairs = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = parseInt(lines[i], 10);
    if (isNaN(code)) continue;
    pairs.push({ code, value: lines[i + 1].trim() });
  }
  return pairs;
}

/* ─────────────────────── Muestreo de curvas básicas ────────────────────── */

/** Cantidad de segmentos para un arco de `angle` radianes. */
function segsForAngle(angle) {
  return Math.max(2, Math.ceil(Math.abs(angle) / (2 * Math.PI) * ARC_SEGS_PER_TURN));
}

/**
 * Expande un "bulge" DXF: arco entre p1 y p2 donde bulge = tan(θ/4).
 * Devuelve los puntos INTERMEDIOS (sin incluir p1 ni p2).
 */
function bulgePoints(p1, p2, bulge) {
  if (!bulge) return [];
  const theta = 4 * Math.atan(bulge);            // ángulo incluido (con signo)
  const dx = p2[0] - p1[0], dy = p2[1] - p1[1];
  const chord = Math.hypot(dx, dy);
  if (chord < 1e-12) return [];
  const radius = chord / (2 * Math.sin(Math.abs(theta) / 2));
  // centro: perpendicular al punto medio de la cuerda
  const mx = (p1[0] + p2[0]) / 2, my = (p1[1] + p2[1]) / 2;
  const h = Math.sqrt(Math.max(0, radius * radius - (chord / 2) * (chord / 2)));
  const sign = bulge > 0 ? 1 : -1;               // >0: arco a la izquierda (CCW)
  const ux = -dy / chord, uy = dx / chord;       // perpendicular unitaria
  const cx = mx - sign * h * ux, cy = my - sign * h * uy;
  const a1 = Math.atan2(p1[1] - cy, p1[0] - cx);
  const n = segsForAngle(theta);
  const out = [];
  for (let i = 1; i < n; i++) {
    const a = a1 + theta * (i / n);
    out.push([cx + radius * Math.cos(a), cy + radius * Math.sin(a)]);
  }
  return out;
}

/** Muestrea un arco de círculo (ángulos en radianes, CCW). */
function arcPoints(cx, cy, r, a1, a2) {
  while (a2 <= a1) a2 += 2 * Math.PI;
  const n = segsForAngle(a2 - a1);
  const out = [];
  for (let i = 0; i <= n; i++) {
    const a = a1 + (a2 - a1) * (i / n);
    out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return out;
}

/* ─────────────────────────── Splines (NURBS) ───────────────────────────── */

/**
 * Evalúa una NURBS racional con el algoritmo de De Boor.
 * @param {number} degree  grado p
 * @param {number[]} knots vector de nudos
 * @param {number[][]} ctrl puntos de control [[x,y],...]
 * @param {number[]} weights pesos (o null = no racional)
 * @param {number} t parámetro
 */
function deBoor(degree, knots, ctrl, weights, t) {
  const n = ctrl.length - 1;
  // localizar el intervalo k tal que knots[k] <= t < knots[k+1]
  let k = -1;
  for (let i = degree; i <= n; i++) {
    if (t >= knots[i] && t <= knots[i + 1] + 1e-12) { k = i; }
  }
  if (k < 0) k = n;
  // puntos homogéneos del soporte local
  const d = [];
  for (let j = 0; j <= degree; j++) {
    const idx = k - degree + j;
    const w = weights ? weights[idx] : 1;
    d.push([ctrl[idx][0] * w, ctrl[idx][1] * w, w]);
  }
  for (let r = 1; r <= degree; r++) {
    for (let j = degree; j >= r; j--) {
      const i = k - degree + j;
      const den = knots[i + degree - r + 1] - knots[i];
      const alpha = den < 1e-12 ? 0 : (t - knots[i]) / den;
      d[j] = [
        (1 - alpha) * d[j - 1][0] + alpha * d[j][0],
        (1 - alpha) * d[j - 1][1] + alpha * d[j][1],
        (1 - alpha) * d[j - 1][2] + alpha * d[j][2],
      ];
    }
  }
  const w = d[degree][2] || 1;
  return [d[degree][0] / w, d[degree][1] / w];
}

/** Muestrea una SPLINE DXF completa a una polilínea. */
function sampleSpline(ent) {
  const { degree, knots, ctrlPts, weights, fitPts, closed } = ent;

  // Caso normal: puntos de control + nudos
  if (ctrlPts.length >= 2 && knots.length >= ctrlPts.length + degree + 1) {
    const t0 = knots[degree];
    const t1 = knots[knots.length - 1 - degree];
    const spans = Math.max(1, ctrlPts.length - degree);
    const samples = Math.min(512, Math.max(24, spans * SPLINE_SAMPLES_PER_SPAN));
    const out = [];
    for (let i = 0; i <= samples; i++) {
      const t = t0 + (t1 - t0) * (i / samples);
      out.push(deBoor(degree, knots, ctrlPts, weights, t));
    }
    return { pts: out, closed };
  }

  // Respaldo: solo fit points → interpolación Catmull-Rom
  if (fitPts.length >= 2) {
    const P = fitPts;
    const out = [];
    const seg = 8;
    const get = (i) => P[U.clamp(i, 0, P.length - 1)];
    for (let i = 0; i < P.length - 1; i++) {
      const p0 = get(i - 1), p1 = get(i), p2 = get(i + 1), p3 = get(i + 2);
      for (let j = 0; j < seg; j++) {
        const t = j / seg, t2 = t * t, t3 = t2 * t;
        out.push([
          0.5 * ((2 * p1[0]) + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
          0.5 * ((2 * p1[1]) + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3),
        ]);
      }
    }
    out.push(P[P.length - 1]);
    return { pts: out, closed };
  }

  return { pts: [], closed: false };
}

/* ──────────────────────────── Parser principal ─────────────────────────── */

/**
 * Parsea un DXF completo.
 * @param {string} text contenido del archivo
 * @returns {{contours: Array, warnings: string[], stats: Object}}
 */
function parse(text) {
  const pairs = tokenize(text);
  const warnings = [];
  const layers = {};        // nombre → { color: '#hex'|null }
  let insunits = null;      // $INSUNITS del HEADER

  /* Entidades crudas recolectadas:
     cerradas → contornos directos; abiertas → a encadenar. */
  const closedPaths = [];   // { pts, colorInfo }
  const openPaths = [];     // { pts, colorInfo }
  const skipped = {};       // tipo → cantidad (para warnings)

  /* ── Recorrido por secciones ── */
  let i = 0;
  const N = pairs.length;

  function readEntityCodes(start) {
    // Lee los códigos de una entidad desde `start` (exclusive el 0 inicial)
    // hasta el próximo código 0. Devuelve [multimapa, índiceSiguiente].
    const m = new Map(); // code → [values...]
    let j = start;
    while (j < N && pairs[j].code !== 0) {
      if (!m.has(pairs[j].code)) m.set(pairs[j].code, []);
      m.get(pairs[j].code).push(pairs[j].value);
      j++;
    }
    return [m, j];
  }
  const first = (m, code, dflt) => m.has(code) ? m.get(code)[0] : dflt;
  const num = (m, code, dflt) => m.has(code) ? parseFloat(m.get(code)[0]) : dflt;
  const nums = (m, code) => (m.get(code) || []).map(parseFloat);

  function colorInfoFrom(m) {
    return {
      aci: m.has(62) ? parseInt(m.get(62)[0], 10) : null,
      truecolor: m.has(420) ? parseInt(m.get(420)[0], 10) : null,
      layer: first(m, 8, '0'),
    };
  }

  while (i < N) {
    const p = pairs[i];

    /* ── HEADER: unidades ── */
    if (p.code === 9 && p.value === '$INSUNITS') {
      for (let j = i + 1; j < Math.min(i + 6, N); j++) {
        if (pairs[j].code === 70) { insunits = parseInt(pairs[j].value, 10); break; }
        if (pairs[j].code === 9 || pairs[j].code === 0) break;
      }
      i++; continue;
    }

    /* ── TABLES: capas ── */
    if (p.code === 0 && p.value === 'LAYER') {
      const [m, next] = readEntityCodes(i + 1);
      const name = first(m, 2, null);
      if (name != null) {
        let color = null;
        if (m.has(420)) color = U.normHex(parseInt(m.get(420)[0], 10));
        else if (m.has(62)) {
          const aci = Math.abs(parseInt(m.get(62)[0], 10)); // negativo = capa apagada
          if (aci >= 1 && aci <= 255) color = U.aciToHex(aci);
        }
        layers[name] = { color };
      }
      i = next; continue;
    }

    if (p.code !== 0) { i++; continue; }
    const type = p.value;

    /* ── ENTIDADES ── */
    switch (type) {

      case 'LWPOLYLINE': {
        const [m, next] = readEntityCodes(i + 1);
        // Los vértices vienen como series 10/20 (+42 bulge opcional por vértice).
        // Hay que recorrer los pares EN ORDEN para asociar cada bulge a su vértice.
        const verts = []; // {x, y, bulge}
        {
          let cur = null;
          for (let j = i + 1; j < next; j++) {
            const c = pairs[j].code, v = pairs[j].value;
            if (c === 10) { cur = { x: parseFloat(v), y: 0, bulge: 0 }; verts.push(cur); }
            else if (c === 20 && cur) cur.y = parseFloat(v);
            else if (c === 42 && cur) cur.bulge = parseFloat(v);
          }
        }
        const flags = parseInt(first(m, 70, '0'), 10);
        const closed = !!(flags & 1);
        if (verts.length >= 2) {
          const pts = [];
          for (let k = 0; k < verts.length; k++) {
            const a = verts[k];
            pts.push([a.x, a.y]);
            const isLast = k === verts.length - 1;
            if (a.bulge && (!isLast || closed)) {
              const b = verts[(k + 1) % verts.length];
              pts.push(...bulgePoints([a.x, a.y], [b.x, b.y], a.bulge));
            }
          }
          if (!closed) pts.push([verts[verts.length - 1].x, verts[verts.length - 1].y]);
          // (si es cerrada, el cierre es implícito)
          const entry = { pts: dedupeTail(pts), colorInfo: colorInfoFrom(m) };
          (closed ? closedPaths : openPaths).push(entry);
        }
        i = next; continue;
      }

      case 'POLYLINE': {
        // POLYLINE clásica: la siguen entidades VERTEX y cierra SEQEND.
        const [m, afterHeader] = readEntityCodes(i + 1);
        const flags = parseInt(first(m, 70, '0'), 10);
        const closed = !!(flags & 1);
        const verts = [];
        let j = afterHeader;
        while (j < N) {
          if (pairs[j].code === 0 && pairs[j].value === 'VERTEX') {
            const [vm, vNext] = readEntityCodes(j + 1);
            verts.push({ x: num(vm, 10, 0), y: num(vm, 20, 0), bulge: num(vm, 42, 0) });
            j = vNext;
          } else if (pairs[j].code === 0 && pairs[j].value === 'SEQEND') {
            const [, sNext] = readEntityCodes(j + 1);
            j = sNext; break;
          } else break;
        }
        if (verts.length >= 2) {
          const pts = [];
          for (let k = 0; k < verts.length; k++) {
            const a = verts[k];
            pts.push([a.x, a.y]);
            const isLast = k === verts.length - 1;
            if (a.bulge && (!isLast || closed)) {
              const b = verts[(k + 1) % verts.length];
              pts.push(...bulgePoints([a.x, a.y], [b.x, b.y], a.bulge));
            }
          }
          const entry = { pts: dedupeTail(pts), colorInfo: colorInfoFrom(m) };
          (closed ? closedPaths : openPaths).push(entry);
        }
        i = j; continue;
      }

      case 'LINE': {
        const [m, next] = readEntityCodes(i + 1);
        const pts = [[num(m, 10, 0), num(m, 20, 0)], [num(m, 11, 0), num(m, 21, 0)]];
        openPaths.push({ pts, colorInfo: colorInfoFrom(m) });
        i = next; continue;
      }

      case 'ARC': {
        const [m, next] = readEntityCodes(i + 1);
        const cx = num(m, 10, 0), cy = num(m, 20, 0), r = num(m, 40, 0);
        const a1 = (num(m, 50, 0) * Math.PI) / 180;
        const a2 = (num(m, 51, 0) * Math.PI) / 180;
        if (r > 0) openPaths.push({ pts: arcPoints(cx, cy, r, a1, a2), colorInfo: colorInfoFrom(m) });
        i = next; continue;
      }

      case 'CIRCLE': {
        const [m, next] = readEntityCodes(i + 1);
        const cx = num(m, 10, 0), cy = num(m, 20, 0), r = num(m, 40, 0);
        if (r > 0) {
          const pts = arcPoints(cx, cy, r, 0, 2 * Math.PI);
          pts.pop(); // el cierre es implícito
          closedPaths.push({ pts, colorInfo: colorInfoFrom(m) });
        }
        i = next; continue;
      }

      case 'ELLIPSE': {
        const [m, next] = readEntityCodes(i + 1);
        const cx = num(m, 10, 0), cy = num(m, 20, 0);
        const majX = num(m, 11, 1), majY = num(m, 21, 0);
        const ratio = num(m, 40, 1);
        const t0 = num(m, 41, 0), t1 = num(m, 42, 2 * Math.PI);
        const full = Math.abs((t1 - t0) - 2 * Math.PI) < 1e-6;
        const n = segsForAngle(t1 - t0);
        const pts = [];
        for (let k = 0; k <= n; k++) {
          const t = t0 + (t1 - t0) * (k / n);
          const ct = Math.cos(t), st = Math.sin(t);
          pts.push([
            cx + ct * majX - st * ratio * majY,
            cy + ct * majY + st * ratio * majX,
          ]);
        }
        if (full) {
          pts.pop();
          closedPaths.push({ pts, colorInfo: colorInfoFrom(m) });
        } else {
          openPaths.push({ pts, colorInfo: colorInfoFrom(m) });
        }
        i = next; continue;
      }

      case 'SPLINE': {
        const [m, next] = readEntityCodes(i + 1);
        const flags = parseInt(first(m, 70, '0'), 10);
        const closedFlag = !!(flags & 1);
        const degree = parseInt(first(m, 71, '3'), 10) || 3;
        const knots = nums(m, 40);
        const xs = nums(m, 10), ys = nums(m, 20);
        const ctrlPts = xs.map((x, k) => [x, ys[k] || 0]);
        const weights = m.has(41) ? nums(m, 41) : null;
        const fx = nums(m, 11), fy = nums(m, 21);
        const fitPts = fx.map((x, k) => [x, fy[k] || 0]);
        const res = sampleSpline({ degree, knots, ctrlPts, weights, fitPts, closed: closedFlag });
        if (res.pts.length >= 2) {
          const entry = { pts: dedupeTail(res.pts), colorInfo: colorInfoFrom(m) };
          if (closedFlag || U.dist2(res.pts[0], res.pts[res.pts.length - 1]) < 1e-12) {
            // quitar cierre duplicado si lo hay
            const pts = entry.pts.slice();
            if (pts.length > 2 && U.dist2(pts[0], pts[pts.length - 1]) < 1e-12) pts.pop();
            closedPaths.push({ pts, colorInfo: entry.colorInfo });
          } else {
            openPaths.push(entry);
          }
        }
        i = next; continue;
      }

      case 'SECTION': case 'ENDSEC': case 'EOF': case 'TABLE': case 'ENDTAB':
      case 'VERTEX': case 'SEQEND': case 'CLASS': case 'BLOCK': case 'ENDBLK': {
        const [, next] = readEntityCodes(i + 1);
        i = next; continue;
      }

      default: {
        // Entidad no soportada (TEXT, HATCH, INSERT, DIMENSION, ...)
        const [m, next] = readEntityCodes(i + 1);
        if (/^(TEXT|MTEXT|HATCH|INSERT|DIMENSION|POINT|SOLID|3DFACE|IMAGE|WIPEOUT)$/.test(type)) {
          skipped[type] = (skipped[type] || 0) + 1;
        }
        void m;
        i = next; continue;
      }
    }
  }

  /* ── Resolución de color por entidad ── */
  function resolveColor(ci) {
    if (!ci) return null;
    if (ci.truecolor != null && isFinite(ci.truecolor)) return U.normHex(ci.truecolor & 0xFFFFFF);
    let aci = ci.aci;
    if (aci == null || aci === 256 || aci === 0) {
      // BYLAYER (o BYBLOCK, que tratamos igual): color de la capa
      const layer = layers[ci.layer];
      return layer ? layer.color : null;
    }
    aci = Math.abs(aci);
    if (aci >= 1 && aci <= 255) return U.aciToHex(aci);
    return null;
  }

  /* ── Escala de unidades → milímetros ── */
  const UNIT_SCALE = { 0: 1, 1: 25.4, 2: 304.8, 4: 1, 5: 10, 6: 1000 };
  const scale = UNIT_SCALE[insunits] != null ? UNIT_SCALE[insunits] : 1;

  function applyScale(pts) {
    if (scale === 1) return pts;
    return pts.map((p) => [p[0] * scale, p[1] * scale]);
  }

  /* ── Encadenar segmentos abiertos en anillos cerrados ── */
  const allBoxes = [];
  for (const c of closedPaths) allBoxes.push(U.bboxOf(c.pts));
  for (const c of openPaths) if (c.pts.length) allBoxes.push(U.bboxOf(c.pts));
  const docBox = U.bboxUnion(allBoxes);
  const diag = docBox ? Math.hypot(docBox.w, docBox.h) * scale : 100;
  // Tolerancia de unión: proporcional al tamaño del dibujo, acotada.
  const joinTol = U.clamp(diag * 1e-5, 1e-6, 0.05);

  const chains = openPaths
    .map((c) => ({ pts: applyScale(c.pts), colorInfo: c.colorInfo }))
    .filter((c) => c.pts.length >= 2);

  const { loops, leftover } = chainIntoLoops(chains, joinTol);
  if (leftover > 0) {
    warnings.push(`${leftover} segmento(s) abiertos no formaron un contorno cerrado y se descartaron.`);
  }
  for (const t of Object.keys(skipped)) {
    warnings.push(`Se ignoraron ${skipped[t]} entidad(es) ${t} (no son contornos).`);
  }

  /* ── Contornos finales ── */
  const contours = [];
  for (const c of closedPaths) {
    const pts = U.cleanPolygon(applyScale(c.pts), joinTol);
    if (pts.length >= 3) contours.push({ pts, color: resolveColor(c.colorInfo), layer: c.colorInfo.layer });
  }
  for (const l of loops) {
    const pts = U.cleanPolygon(l.pts, joinTol);
    if (pts.length >= 3) contours.push({ pts, color: resolveColor(l.colorInfo), layer: l.colorInfo.layer });
  }

  /* ── Recentrado en el origen ──
     Los DXF suelen venir con coordenadas absolutas del lienzo original
     (a veces a miles de mm del origen). La grilla del visor está fija en
     (0,0), así que sin este paso el modelo importado aparece "perdido"
     lejos de la grilla. Se centra el bbox 2D completo en (0,0). */
  const fullBox = U.bboxUnion(contours.map((c) => U.bboxOf(c.pts)));
  if (fullBox) {
    const dx = -fullBox.cx, dy = -fullBox.cy;
    if (Math.abs(dx) > 1e-9 || Math.abs(dy) > 1e-9) {
      for (const c of contours) c.pts = c.pts.map((p) => [p[0] + dx, p[1] + dy]);
    }
  }

  return {
    contours,
    warnings,
    stats: {
      closedEntities: closedPaths.length,
      openSegments: openPaths.length,
      assembledLoops: loops.length,
      unitScale: scale,
    },
  };
}

/** Quita puntos duplicados consecutivos sin cerrar el anillo. */
function dedupeTail(pts) {
  const out = [];
  for (const p of pts) {
    if (!out.length || U.dist2(out[out.length - 1], p) > 1e-16) out.push(p);
  }
  return out;
}

/**
 * Une polilíneas abiertas por proximidad de extremos hasta formar anillos.
 * Algoritmo voraz: toma una cadena y busca la cadena cuyo extremo esté más
 * cerca de su final (invirtiéndola si hace falta); repite hasta cerrar o
 * quedarse sin candidatas.
 */
function chainIntoLoops(chains, tol) {
  const tol2 = tol * tol;
  const pool = chains.map((c) => ({ pts: c.pts.slice(), colorInfo: c.colorInfo, used: false }));
  const loops = [];
  let leftover = 0;

  for (let s = 0; s < pool.length; s++) {
    if (pool[s].used) continue;
    pool[s].used = true;
    let cur = pool[s].pts.slice();
    const colorInfo = pool[s].colorInfo;

    // ¿ya viene cerrada?
    let guard = pool.length + 2;
    while (guard-- > 0) {
      if (cur.length >= 3 && U.dist2(cur[0], cur[cur.length - 1]) <= Math.max(tol2, 1e-12)) {
        cur.pop();
        loops.push({ pts: cur, colorInfo });
        cur = null;
        break;
      }
      // buscar la mejor continuación desde el extremo final
      const tail = cur[cur.length - 1];
      let best = null, bestD = Infinity, bestRev = false;
      for (const cand of pool) {
        if (cand.used) continue;
        const d0 = U.dist2(tail, cand.pts[0]);
        const d1 = U.dist2(tail, cand.pts[cand.pts.length - 1]);
        if (d0 < bestD) { bestD = d0; best = cand; bestRev = false; }
        if (d1 < bestD) { bestD = d1; best = cand; bestRev = true; }
      }
      if (!best || bestD > tol2) { leftover++; cur = null; break; }
      best.used = true;
      const seg = bestRev ? best.pts.slice().reverse() : best.pts.slice();
      // evitar duplicar el punto de unión
      cur = cur.concat(seg.slice(1));
    }
    if (cur) leftover++; // guard agotado (no debería pasar)
  }
  return { loops, leftover };
}

INKORA.DXF = { parse };
})(typeof window !== 'undefined' ? window : globalThis);
