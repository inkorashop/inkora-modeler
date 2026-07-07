/* ============================================================================
   INKORA · topology.js
   ----------------------------------------------------------------------------
   Clasificación topológica de los contornos importados. Resuelve el problema
   central del programa: distinguir entre

   · SÓLIDO    — contorno que representa material (base, letra, figura)
   · INTERIOR  — hueco de una figura que tiene OTRO sólido por detrás
                 (ej: el interior de una letra "O" apoyada sobre la base).
                 Es una cara seleccionable y extruible por separado.
   · VACÍO     — hueco real sin nada detrás (ej: el agujero de la argolla
                 del llavero). NUNCA se rellena ni se puede seleccionar.

   Método:
   1. Se construye el árbol de contención (cada contorno cuelga del contorno
      más chico que lo contiene).
   2. Rol por paridad + color: un hijo con color propio distinto al efectivo
      del padre inicia un sólido nuevo (letra sobre base); un hijo del mismo
      color alterna sólido/hueco (compound paths de Corel: letra + contra).
   3. Cada hueco busca su "respaldo": el sólido más cercano (de otro objeto)
      cuya región rellena cubre el punto interior del hueco. Sin respaldo ⇒
      vacío real.

   Entrada:  [{ pts, color, layer }]
   Salida:   { contours (enriquecidos), faces, warnings }
             faces = [{ contourIdx, kind:'solid'|'interior', holes:[idx],
                        color, depth, repPt }]
   ============================================================================ */
(function (global) {
'use strict';

const INKORA = global.INKORA = global.INKORA || {};
const U = INKORA.Utils;

/* Área mínima en mm² para considerar un contorno (descarta basura del DXF). */
const MIN_AREA = 0.01;

/**
 * Clasifica los contornos crudos y deriva las caras seleccionables.
 * @param {Array<{pts:Array, color:string|null, layer:string}>} raw
 */
function classify(raw) {
  const warnings = [];

  /* ── 1. Normalización ── */
  const contours = [];
  for (const r of raw) {
    const pts = U.cleanPolygon(r.pts, 1e-6);
    if (pts.length < 3) continue;
    const area = U.polygonArea(pts);
    if (area < MIN_AREA) continue;
    contours.push({
      pts,
      area,
      bbox: U.bboxOf(pts),
      color: r.color ? U.normHex(r.color) : null,
      layer: r.layer || '0',
      // se completan más abajo:
      parent: -1, children: [], depth: 0,
      role: 'solid',           // 'solid' | 'hole'
      effColor: null,          // color efectivo (heredado si no tiene propio)
      backer: -1,              // para huecos: índice del sólido de respaldo
      isVoid: false,           // para huecos: true = vacío real
      repPt: null,             // punto interior representativo
      duplicate: false,
    });
  }

  /* ── 1b. Detección de contornos duplicados exactos ──
     Algunos DXF traen el mismo trazo dos veces (contorno + relleno de Corel).
     Dos contornos con área y bbox prácticamente idénticos se consideran uno. */
  for (let i = 0; i < contours.length; i++) {
    if (contours[i].duplicate) continue;
    for (let j = i + 1; j < contours.length; j++) {
      const a = contours[i], b = contours[j];
      if (b.duplicate) continue;
      const areaTol = Math.max(a.area, b.area) * 1e-3 + 1e-9;
      if (Math.abs(a.area - b.area) > areaTol) continue;
      const bt = Math.sqrt(areaTol);
      if (Math.abs(a.bbox.minX - b.bbox.minX) < bt && Math.abs(a.bbox.minY - b.bbox.minY) < bt &&
          Math.abs(a.bbox.maxX - b.bbox.maxX) < bt && Math.abs(a.bbox.maxY - b.bbox.maxY) < bt) {
        b.duplicate = true;
        // si el duplicado aporta color y el original no, heredarlo
        if (!a.color && b.color) a.color = b.color;
      }
    }
  }
  const live = contours.map((c, i) => i).filter((i) => !contours[i].duplicate);
  const dupCount = contours.length - live.length;
  if (dupCount > 0) warnings.push(`Se unificaron ${dupCount} contorno(s) duplicados.`);

  /* ── 2. Árbol de contención ──
     Padre = el contorno más chico (por área) que contiene un punto interior
     del hijo. Prefiltro por bbox y área para que sea rápido. */

  // punto interior provisional (sin conocer aún los hijos): innerPoint simple
  for (const i of live) {
    contours[i].repPt = U.innerPoint(contours[i].pts, []);
    if (!contours[i].repPt) contours[i].duplicate = true; // degenerado
  }
  const valid = live.filter((i) => !contours[i].duplicate);

  for (const i of valid) {
    const c = contours[i];
    let best = -1, bestArea = Infinity;
    for (const j of valid) {
      if (j === i) continue;
      const o = contours[j];
      if (o.area <= c.area) continue;                       // el padre es más grande
      if (o.area >= bestArea) continue;                     // ya hay uno más chico
      if (!U.bboxContainsBbox(o.bbox, c.bbox, 1e-6)) continue;
      if (U.pointInPolygon(c.repPt, o.pts)) { best = j; bestArea = o.area; }
    }
    c.parent = best;
    if (best >= 0) contours[best].children.push(i);
  }
  for (const i of valid) {
    let d = 0, p = contours[i].parent;
    while (p >= 0) { d++; p = contours[p].parent; }
    contours[i].depth = d;
  }

  /* ── 3. Roles por color, capa y geometría ──
     Recorrido en orden de profundidad (padres antes que hijos).

     El color por sí solo no alcanza: muchos DXF de logos/letras no traen
     color por objeto (todo en capa "0", sin código 62/420). Si en ese caso
     se asumiera "mismo color = alternar sólido/hueco" a ciegas, una letra
     completa apoyada sobre la base terminaría clasificada como HUECO
     (porque comparte el "sin color" de la base), no solo su contorno
     interior — el bug reportado. Por eso, cuando no hay color ni capa que
     lo distingan del padre, se decide por geometría:

     · Ambigüedad principal: un hijo DIRECTO de la base raíz puede ser un
       agujero perforado real (la argolla) o una figura apoyada encima
       (una letra). Ambos pueden ser redondeados (una "O" es tan compacta
       como un agujero), así que la compacidad sola no alcanza ahí: si ese
       hijo tiene a su vez hijos propios (ej. la "O" tiene su propia
       contra), no puede ser un agujero perforado simple —un agujero real
       nunca contiene otra figura adentro— y se resuelve como figura nueva.
     · Para el resto de los niveles (ej. la contra de esa "O", que sí puede
       contener una isla decorativa más chica) esa regla ya no aplica: ahí
       la compacidad sola decide, porque el nivel superior ya resolvió la
       ambigüedad letra-vs-agujero. */
  // 1.0 = círculo perfecto; un cuadrado ronda 0.79 y las letras 0.2–0.6.
  // Un ojal de llavero funcional es siempre redondeado/ovalado (para que la
  // argolla deslice bien), así que el umbral se fija alto a propósito: deja
  // pasar círculos y óvalos, pero excluye cualquier figura angulosa —incluso
  // bloques/decoraciones cuadradas— para minimizar falsos huecos en letras.
  const HOLE_COMPACTNESS_MIN = 0.8;
  const byDepth = valid.slice().sort((a, b) => contours[a].depth - contours[b].depth);
  for (const i of byDepth) {
    const c = contours[i];
    if (c.parent < 0) {
      c.role = 'solid';
      c.effColor = c.color;
      continue;
    }
    const par = contours[c.parent];
    const ownsColor = c.color != null && par.effColor != null && c.color !== par.effColor;
    const ownsLayer = c.layer !== par.layer;

    if (ownsColor || ownsLayer) {
      // color o capa propia y distinta del padre → objeto nuevo apoyado
      // encima (ej: letra en su propia capa/color sobre la base)
      c.role = 'solid';
    } else if (par.role === 'hole') {
      // dentro de un hueco ya confirmado: por alternancia normal es una
      // isla sólida (ej. el punto de una "i" dentro de un hueco decorativo)
      c.role = 'solid';
    } else {
      // mismo color/capa que un padre sólido, sin más pistas: puede ser
      // la contra propia de este objeto o una figura nueva sin metadatos
      const parIsRoot = par.parent < 0;
      const disqualifiedByChildren = parIsRoot && c.children.length > 0;
      c.role = (!disqualifiedByChildren && U.compactness(c.pts) >= HOLE_COMPACTNESS_MIN) ? 'hole' : 'solid';
    }
    c.effColor = c.color != null ? c.color : par.effColor;
  }

  /* ── 3b. Punto interior definitivo (evitando los hijos directos) ──
     Necesario para que el repPt de un hueco no caiga dentro de una isla
     interior (ej: la "o" dentro de un aro). */
  for (const i of valid) {
    const c = contours[i];
    const childHoles = c.children.map((k) => contours[k].pts);
    const p = U.innerPoint(c.pts, childHoles);
    if (p) c.repPt = p;
  }

  /* ── 4. Respaldo de huecos: ¿interior de letra o vacío real? ──
     La región rellena de un sólido S = dentro de S, fuera de sus huecos
     directos. Un hueco H está "respaldado" si el repPt de H cae en la
     región rellena de algún sólido que no sea su dueño ni un descendiente. */

  // descendientes de cada contorno (para excluir islas internas del hueco)
  function isDescendantOf(i, ancestor) {
    let p = contours[i].parent;
    while (p >= 0) { if (p === ancestor) return true; p = contours[p].parent; }
    return false;
  }

  function filledRegionContains(solidIdx, pt) {
    const s = contours[solidIdx];
    if (!U.pointInPolygon(pt, s.pts)) return false;
    for (const k of s.children) {
      if (contours[k].role === 'hole' && U.pointInPolygon(pt, contours[k].pts)) return false;
    }
    return true;
  }

  for (const i of valid) {
    const c = contours[i];
    if (c.role !== 'hole') continue;
    let best = -1, bestArea = Infinity;
    for (const j of valid) {
      if (j === i || j === c.parent) continue;
      const s = contours[j];
      if (s.role !== 'solid') continue;
      if (isDescendantOf(j, i)) continue;        // islas dentro del hueco no respaldan
      if (s.area < bestArea && filledRegionContains(j, c.repPt)) {
        best = j; bestArea = s.area;
      }
    }
    c.backer = best;
    c.isVoid = best < 0;
  }

  /* ── 5. Caras seleccionables ──
     · Cada sólido es una cara (con sus huecos directos como agujeros).
     · Cada hueco respaldado es una cara "interior" (sus islas directas
       actúan de agujeros), con el color del sólido de respaldo. */
  const faces = [];
  for (const i of valid) {
    const c = contours[i];
    if (c.role === 'solid') {
      faces.push({
        contourIdx: i,
        kind: 'solid',
        holes: c.children.filter((k) => contours[k].role === 'hole'),
        color: c.effColor,
        depth: c.depth,
        repPt: c.repPt,
      });
    } else if (!c.isVoid) {
      faces.push({
        contourIdx: i,
        kind: 'interior',
        holes: c.children.filter((k) => contours[k].role === 'solid'),
        color: contours[c.backer].effColor,
        depth: c.depth,
        repPt: c.repPt,
      });
    }
  }
  // Orden estable: primero por profundidad, después por área descendente
  faces.sort((a, b) => a.depth - b.depth || contours[b.contourIdx].area - contours[a.contourIdx].area);

  const voidCount = valid.filter((i) => contours[i].role === 'hole' && contours[i].isVoid).length;

  return {
    contours,
    faces,
    warnings,
    stats: { solids: faces.filter(f => f.kind === 'solid').length, interiors: faces.filter(f => f.kind === 'interior').length, voids: voidCount },
  };
}

/**
 * Devuelve los anillos de una región lista para extruir/dibujar:
 * exterior CCW + agujeros CW.
 * @param {Array} contours  lista enriquecida de classify()
 * @param {{outer:number, holes:number[]}} region
 */
function regionRings(contours, region) {
  return {
    outer: U.withWinding(contours[region.outer].pts, true),
    holes: region.holes.map((h) => U.withWinding(contours[h].pts, false)),
  };
}

INKORA.Topology = { classify, regionRings, MIN_AREA };
})(typeof window !== 'undefined' ? window : globalThis);
