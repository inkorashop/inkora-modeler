/* ============================================================================
   INKORA · exporter.js
   ----------------------------------------------------------------------------
   Exportador 3MF multicolor para BambuStudio / OrcaSlicer.

   Estrategia anti-mezcla de colores: cada pieza se exporta como un OBJETO
   independiente dentro del 3MF, con su propio material (displaycolor).
   El laminador los trata como partes separadas de un mismo modelo y asigna
   un filamento por color — los colores nunca se funden entre sí.

   Estrategia anti-huecos (manifold): la malla de cada pieza se construye
   con vértices COMPARTIDOS entre tapas y paredes (mismo anillo de puntos
   abajo y arriba). Cada arista pertenece exactamente a 2 triángulos con
   orientación opuesta ⇒ malla estanca por construcción, sin soldaduras
   posteriores ni reparaciones en el laminador.

   El archivo .3mf es un ZIP: acá también se escribe a mano (método STORE
   + CRC32), sin depender de librerías externas.

   Requiere THREE (ShapeUtils.triangulateShape) para triangular las tapas.
   ============================================================================ */
(function (global) {
'use strict';

const INKORA = global.INKORA = global.INKORA || {};
const U = INKORA.Utils;

/* ─────────────────────── Malla de una pieza ────────────────────────────── */

/**
 * Construye la malla 3D (vértices + triángulos) de una pieza extruida.
 * @param {Object} state  estado del modelo (por los contornos)
 * @param {Object} piece  pieza {regions, baseZ, height}
 * @returns {{vertices:number[][], triangles:number[][], warnings:string[]}}
 */
function buildPieceMesh(state, piece) {
  const THREE = global.THREE;
  const vertices = [];   // [x, y, z]
  const triangles = [];  // [a, b, c] con normal hacia afuera
  const warnings = [];
  const z0 = piece.baseZ;
  const z1 = piece.baseZ + piece.height;

  for (const region of piece.regions) {
    const rings = INKORA.Topology.regionRings(state.contours, {
      outer: region.outer,
      holes: region.holes,
    });
    const outer = rings.outer;              // CCW
    const holes = rings.holes;              // CW
    if (outer.length < 3) continue;

    // ── triangulación de la tapa (índices sobre outer ++ holes) ──
    const contourV2 = outer.map((p) => new THREE.Vector2(p[0], p[1]));
    const holesV2 = holes.map((h) => h.map((p) => new THREE.Vector2(p[0], p[1])));
    let capTris;
    try {
      capTris = THREE.ShapeUtils.triangulateShape(contourV2, holesV2);
    } catch (e) {
      warnings.push('No se pudo triangular una región (¿contorno auto-intersectado?).');
      continue;
    }
    if (!capTris.length) {
      warnings.push('Una región quedó vacía al triangular y fue omitida.');
      continue;
    }

    // ── vértices: anillos abajo (z0) y arriba (z1), compartidos ──
    const allPts = outer.concat(...holes);
    const base = vertices.length;           // offset de esta región
    const N = allPts.length;
    for (const p of allPts) vertices.push([p[0], p[1], z0]);
    for (const p of allPts) vertices.push([p[0], p[1], z1]);
    const B = (k) => base + k;              // vértice inferior k
    const T = (k) => base + N + k;          // vértice superior k

    // ── tapas ──
    // La normal de la tapa superior debe mirar a +Z: triángulo CCW en XY.
    for (const tri of capTris) {
      const [a, b, c] = tri;
      const area2 =
        (allPts[b][0] - allPts[a][0]) * (allPts[c][1] - allPts[a][1]) -
        (allPts[c][0] - allPts[a][0]) * (allPts[b][1] - allPts[a][1]);
      if (Math.abs(area2) < 1e-12) continue;              // degenerado
      const ccw = area2 > 0;
      const [p, q, r] = ccw ? [a, b, c] : [a, c, b];
      triangles.push([T(p), T(q), T(r)]);                  // arriba: CCW → +Z
      triangles.push([B(p), B(r), B(q)]);                  // abajo: invertida → −Z
    }

    // ── paredes ──
    // Para un anillo exterior CCW la pared queda con la normal hacia afuera;
    // los agujeros van en CW, así su pared apunta hacia el interior del
    // agujero (que es el exterior del sólido). Misma fórmula para ambos.
    let start = 0;
    const ringSizes = [outer.length].concat(holes.map((h) => h.length));
    for (const size of ringSizes) {
      for (let k = 0; k < size; k++) {
        const i0 = start + k;
        const i1 = start + ((k + 1) % size);
        triangles.push([B(i0), B(i1), T(i1)]);
        triangles.push([B(i0), T(i1), T(i0)]);
      }
      start += size;
    }
  }

  return { vertices, triangles, warnings };
}

/* ─────────────────────────── XML del modelo ────────────────────────────── */

/** Formatea una coordenada con 4 decimales, sin ceros sobrantes. */
function fmtCoord(v) {
  let s = v.toFixed(4);
  if (s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s === '-0' ? '0' : s;
}

/**
 * Genera el XML 3D/3dmodel.model del paquete 3MF.
 * @param {Array<{name, color, mesh}>} objects
 */
function buildModelXml(objects, title) {
  // paleta de materiales: un <base> por color único
  const colors = [];
  const colorIndex = new Map();
  for (const o of objects) {
    const c = (o.color || '#cccccc').toUpperCase();
    if (!colorIndex.has(c)) { colorIndex.set(c, colors.length); colors.push(c); }
  }

  const L = [];
  L.push('<?xml version="1.0" encoding="UTF-8"?>');
  L.push('<model unit="millimeter" xml:lang="und" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">');
  L.push(` <metadata name="Title">${U.escapeXml(title)}</metadata>`);
  L.push(' <metadata name="Application">INKORA Keychain Modeler</metadata>');
  L.push(' <resources>');
  L.push('  <basematerials id="1">');
  for (let i = 0; i < colors.length; i++) {
    L.push(`   <base name="Color ${i + 1} ${colors[i]}" displaycolor="${colors[i]}FF" />`);
  }
  L.push('  </basematerials>');

  let nextId = 2;
  const itemIds = [];
  for (const o of objects) {
    const id = nextId++;
    itemIds.push(id);
    const pindex = colorIndex.get((o.color || '#cccccc').toUpperCase());
    L.push(`  <object id="${id}" type="model" pid="1" pindex="${pindex}" name="${U.escapeXml(o.name)}">`);
    L.push('   <mesh>');
    L.push('    <vertices>');
    for (const v of o.mesh.vertices) {
      L.push(`     <vertex x="${fmtCoord(v[0])}" y="${fmtCoord(v[1])}" z="${fmtCoord(v[2])}" />`);
    }
    L.push('    </vertices>');
    L.push('    <triangles>');
    for (const t of o.mesh.triangles) {
      L.push(`     <triangle v1="${t[0]}" v2="${t[1]}" v3="${t[2]}" />`);
    }
    L.push('    </triangles>');
    L.push('   </mesh>');
    L.push('  </object>');
  }
  L.push(' </resources>');
  L.push(' <build>');
  for (const id of itemIds) L.push(`  <item objectid="${id}" />`);
  L.push(' </build>');
  L.push('</model>');
  return L.join('\n');
}

/* ─────────────────────────── Escritor ZIP ──────────────────────────────── */

/* Tabla CRC32 estándar (polinomio 0xEDB88320). */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC32 de un Uint8Array. */
function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/**
 * Crea un ZIP sin compresión (método STORE) — válido y universal.
 * @param {Array<{name:string, data:Uint8Array}>} files
 * @returns {Uint8Array}
 */
function makeZip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;

  // fecha en formato DOS
  const d = new Date();
  const dosTime = ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xFFFF;
  const dosDate = (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xFFFF;

  const w16 = (view, pos, v) => view.setUint16(pos, v & 0xFFFF, true);
  const w32 = (view, pos, v) => view.setUint32(pos, v >>> 0, true);

  for (const f of files) {
    const nameBytes = new TextEncoder().encode(f.name);
    const crc = crc32(f.data);

    // ── cabecera local ──
    const lh = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(lh.buffer);
    w32(lv, 0, 0x04034B50);
    w16(lv, 4, 20);            // versión mínima
    w16(lv, 6, 0);             // flags
    w16(lv, 8, 0);             // método STORE
    w16(lv, 10, dosTime);
    w16(lv, 12, dosDate);
    w32(lv, 14, crc);
    w32(lv, 18, f.data.length);
    w32(lv, 22, f.data.length);
    w16(lv, 26, nameBytes.length);
    w16(lv, 28, 0);            // extra
    lh.set(nameBytes, 30);
    chunks.push(lh, f.data);

    // ── entrada del directorio central ──
    const ch = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(ch.buffer);
    w32(cv, 0, 0x02014B50);
    w16(cv, 4, 20);            // versión creadora
    w16(cv, 6, 20);            // versión mínima
    w16(cv, 8, 0);
    w16(cv, 10, 0);
    w16(cv, 12, dosTime);
    w16(cv, 14, dosDate);
    w32(cv, 16, crc);
    w32(cv, 20, f.data.length);
    w32(cv, 24, f.data.length);
    w16(cv, 28, nameBytes.length);
    w16(cv, 30, 0);            // extra
    w16(cv, 32, 0);            // comentario
    w16(cv, 34, 0);            // disco
    w16(cv, 36, 0);            // atributos internos
    w32(cv, 38, 0);            // atributos externos
    w32(cv, 42, offset);       // offset de la cabecera local
    ch.set(nameBytes, 46);
    central.push(ch);

    offset += lh.length + f.data.length;
  }

  const centralSize = central.reduce((s, c) => s + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  w32(ev, 0, 0x06054B50);
  w16(ev, 8, files.length);
  w16(ev, 10, files.length);
  w32(ev, 12, centralSize);
  w32(ev, 16, offset);        // inicio del directorio central
  w16(ev, 20, 0);             // comentario

  const total = offset + centralSize + eocd.length;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) { out.set(c, pos); pos += c.length; }
  for (const c of central) { out.set(c, pos); pos += c.length; }
  out.set(eocd, pos);
  return out;
}

/* ─────────────────────────── Paquete 3MF ───────────────────────────────── */

const CONTENT_TYPES =
`<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml" />
 <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml" />
</Types>`;

const RELS =
`<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" Target="/3D/3dmodel.model" />
</Relationships>`;

/**
 * Exporta las piezas visibles del estado como 3MF.
 * @returns {{ok:boolean, msg?:string, bytes?:Uint8Array, filename?:string,
 *            stats?:Object, warnings?:string[]}}
 */
function export3MF(state) {
  const pieces = state.pieces.filter((p) => p.visible);
  if (!pieces.length) {
    return { ok: false, msg: 'No hay piezas extruidas para exportar. Extruí al menos una cara.' };
  }

  const warnings = [];
  const objects = [];
  for (const p of pieces) {
    const mesh = buildPieceMesh(state, p);
    warnings.push(...mesh.warnings);
    if (mesh.triangles.length === 0) {
      warnings.push(`La pieza "${p.name}" quedó sin geometría y no se exportó.`);
      continue;
    }
    objects.push({ name: p.name, color: p.color, mesh });
  }
  if (!objects.length) return { ok: false, msg: 'Ninguna pieza generó geometría válida.' };

  const xml = buildModelXml(objects, state.docName || 'llavero');
  const enc = new TextEncoder();
  const bytes = makeZip([
    { name: '[Content_Types].xml', data: enc.encode(CONTENT_TYPES) },
    { name: '_rels/.rels', data: enc.encode(RELS) },
    { name: '3D/3dmodel.model', data: enc.encode(xml) },
  ]);

  const totalTris = objects.reduce((s, o) => s + o.mesh.triangles.length, 0);
  return {
    ok: true,
    bytes,
    filename: (state.docName || 'llavero') + '.3mf',
    stats: { objects: objects.length, triangles: totalTris },
    warnings,
  };
}

INKORA.Exporter = { export3MF, buildPieceMesh, buildModelXml, makeZip, crc32 };
})(typeof window !== 'undefined' ? window : globalThis);
