const electronApi = require('electron');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

if (typeof electronApi === 'string') {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronApi, [__filename], {
    stdio: 'inherit',
    windowsHide: true,
    env,
  });
  child.on('exit', code => process.exit(code ?? 1));
  child.on('error', err => {
    console.error(err);
    process.exit(1);
  });
  return;
}

const { app, BrowserWindow } = electronApi;
const repoRoot = path.resolve(__dirname, '..', '..');
const htmlPath = path.join(repoRoot, 'index.html');
const dxfText = fs.readFileSync(path.join(repoRoot, 'Modelos', 'Tucan.dxf'), 'latin1');
const svgText = fs.readFileSync(path.join(repoRoot, 'Modelos', 'Tucan.svg'), 'utf8');
// Diseño por capas denso (5 colores, ~130 regiones visibles). Cubre el caso
// que el Tucan no ejercita: muchos objetos del mismo color, un unico hueco
// real y "seleccionar todo + extruir" sobre todo el modelo.
const layeredDxfText = fs.readFileSync(path.join(repoRoot, 'Modelos', 'Cataratas.dxf'), 'latin1');
const layeredSvgText = fs.readFileSync(path.join(repoRoot, 'Modelos', 'Cataratas.svg'), 'utf8');
// Diseño real del usuario con fronteras coincidentes (fondo + letra encima):
// ejercita el fantasma _itemInternalHole y su gemelo de igual tamaño en el
// flujo de click "uno a la vez" (ver DECISIONS.md, bloqueo de click en
// piezas 2D adyacentes al hueco de una letra).
const camemDxfText = fs.readFileSync(path.join(repoRoot, 'Modelos', 'Camem.dxf'), 'latin1');

async function waitForGeometryRuntime(win) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const ready = await win.webContents.executeJavaScript(
      'Boolean(globalThis.THREE && globalThis.ClipperLib && typeof DXFParser !== "undefined" && typeof SVGParser !== "undefined")'
    ).catch(() => false);
    if (ready) return;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('El runtime geometrico no termino de cargar (THREE/Clipper/parser).');
}

async function collectMetrics(win) {
  return win.webContents.executeJavaScript(`(async () => {
    const dxfText = ${JSON.stringify(dxfText)};
    const svgText = ${JSON.stringify(svgText)};
    const layeredDxfText = ${JSON.stringify(layeredDxfText)};
    const layeredSvgText = ${JSON.stringify(layeredSvgText)};
    const camemDxfText = ${JSON.stringify(camemDxfText)};

    function polygonArea(points) {
      let area = 0;
      for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        area += points[j].x * points[i].y - points[i].x * points[j].y;
      }
      return Math.abs(area) / 2;
    }

    function shapeArea(shape) {
      const outer = polygonArea(shape.getPoints(256));
      const holes = (shape.holes || []).reduce((sum, hole) => sum + polygonArea(hole.getPoints(256)), 0);
      return Math.max(0, outer - holes);
    }

    function shapeBounds(shape) {
      const points = shape.getPoints(256);
      return points.reduce((box, point) => ({
        minX: Math.min(box.minX, point.x),
        maxX: Math.max(box.maxX, point.x),
        minY: Math.min(box.minY, point.y),
        maxY: Math.max(box.maxY, point.y),
      }), { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity });
    }

    function summarize(items) {
      const areas = items.map(item => shapeArea(item.shape));
      const signedAreas = items.map((item, index) =>
        areas[index] * (item.depth % 2 === 1 ? -1 : 1)
      );
      return {
        count: items.length,
        totalArea: areas.reduce((sum, area) => sum + area, 0),
        netArea: signedAreas.reduce((sum, area) => sum + area, 0),
        minArea: areas.length ? Math.min(...areas) : 0,
        oddDepthCount: items.filter(item => item.depth % 2 === 1).length,
        voidCount: items.filter(item => item.isVoid).length,
        voidAreas: items.filter(item => item.isVoid).map(item => rounded(item.voidArea)),
        syntheticVoidCount: items.filter(item => item.syntheticVoid).length,
        colorCount: new Set(items.map(item => item.color).filter(Boolean)).size,
      };
    }

    function materialVoidSummary(items) {
      return {
        voidCount: items.filter(item => item.isVoid).length,
        syntheticVoidCount: items.filter(item => item.syntheticVoid).length,
        voidKinds: items.filter(item => item.isVoid).map(item => item.voidKind),
      };
    }

    // color undefined => sin codigo 62, o sea ByLayer: la entidad hereda el
    // color de la capa. Es la diferencia que separa dos objetos distintos de
    // los subtrazados de un mismo objeto compuesto.
    function dxfPolyline(points, color) {
      const tokens = [
        '0', 'LWPOLYLINE',
        '8', 'Test',
        ...(color === undefined ? [] : ['62', String(color)]),
        '90', String(points.length),
        '70', '1',
      ];
      points.forEach(point => {
        tokens.push('10', String(point[0]), '20', String(point[1]));
      });
      return tokens;
    }

    function dxfLayerTable(layerColor) {
      return [
        '0', 'SECTION',
        '2', 'TABLES',
        '0', 'TABLE',
        '2', 'LAYER',
        '0', 'LAYER',
        '2', 'Test',
        '70', '0',
        '62', String(layerColor),
        '6', 'Continuous',
        '0', 'ENDTAB',
        '0', 'ENDSEC',
      ];
    }

    function dxfDocument(polylines, layerColor) {
      return [
        ...(layerColor === undefined ? [] : dxfLayerTable(layerColor)),
        '0', 'SECTION',
        '2', 'ENTITIES',
        ...polylines.flatMap(polyline =>
          dxfPolyline(polyline.points, polyline.color)
        ),
        '0', 'ENDSEC',
        '0', 'EOF',
      ].join('\\n');
    }

    async function testMaterialVoidDetection() {
      const svgStart = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20">';
      const svgDonutPath =
        '<path fill="#000000" fill-rule="evenodd" ' +
        'd="M0 0H20V20H0Z M5 5H15V15H5Z"/>';
      const svgDonut = svgStart + svgDonutPath + '</svg>';
      const svgFilled = svgStart + svgDonutPath +
        '<rect x="5" y="5" width="10" height="10" fill="#ff0000"/>' +
        '</svg>';
      const svgFrame = svgStart +
        '<rect x="0" y="0" width="20" height="5" fill="#000000"/>' +
        '<rect x="0" y="15" width="20" height="5" fill="#000000"/>' +
        '<rect x="0" y="5" width="5" height="10" fill="#000000"/>' +
        '<rect x="15" y="5" width="5" height="10" fill="#000000"/>' +
        '</svg>';
      const outer = [[0, 0], [20, 0], [20, 20], [0, 20]];
      const inner = [[5, 5], [15, 5], [15, 15], [5, 15]];
      const dxfDonut = dxfDocument([
        { points: outer, color: 1 },
        { points: inner, color: 1 },
      ]);
      const dxfFilled = dxfDocument([
        { points: outer, color: 1 },
        { points: inner, color: 1 },
        { points: inner, color: 2 },
      ]);
      // Un objeto blanco apoyado sobre uno negro. En DXF el ACI 7 es "blanco
      // o negro segun el fondo": Corel exporta los dos con el mismo indice y
      // el hex resuelto no los distingue. Lo que sí los distingue es el
      // ORIGEN del color -- la base hereda de la capa, la pieza de arriba
      // trae codigo 62 propio -- y sin eso el blanco se agrupaba como
      // subtrazado, o sea como agujero, y no se podia seleccionar ni extruir.
      const dxfWhiteOnBlack = dxfDocument([
        { points: outer },              // ByLayer -> ACI 7 de la capa
        { points: inner, color: 7 },    // objeto propio, tambien ACI 7
      ], 7);
      // Mismo dibujo, pero los dos anillos con codigo 62 propio: ahi sí son
      // los subtrazados de un compuesto y el agujero tiene que sobrevivir.
      const dxfSameSpecDonut = dxfDocument([
        { points: outer, color: 7 },
        { points: inner, color: 7 },
      ], 7);

      return {
        svgExplicit: materialVoidSummary(await SVGParser.loadText(svgDonut)),
        svgFilled: materialVoidSummary(await SVGParser.loadText(svgFilled)),
        svgComposite: materialVoidSummary(await SVGParser.loadText(svgFrame)),
        dxfInferred: materialVoidSummary(await DXFParser.loadText(dxfDonut)),
        dxfFilled: materialVoidSummary(await DXFParser.loadText(dxfFilled)),
        dxfWhiteOnBlack: materialVoidSummary(await DXFParser.loadText(dxfWhiteOnBlack)),
        dxfSameSpecDonut: materialVoidSummary(await DXFParser.loadText(dxfSameSpecDonut)),
      };
    }

    function resolveRectangles(bottomRect, topRect) {
      const rect = (x1, y1, x2, y2) => [
        { x: x1, y: y1 },
        { x: x2, y: y1 },
        { x: x2, y: y2 },
        { x: x1, y: y2 },
      ];
      const items = [
        { rings: [rect(...bottomRect)], elementId: 'bottom', layer: 'test', color: '#ffffff' },
        { rings: [rect(...topRect)], elementId: 'top', layer: 'test', color: '#000000' },
      ];
      const result = SVGVisibleGeometry.resolve(items);
      const bottom = result.find(item => item.elementId.startsWith('bottom'));
      const top = result.find(item => item.elementId.startsWith('top'));
      return {
        count: result.length,
        bottomBounds: bottom ? shapeBounds(bottom.shape) : null,
        topBounds: top ? shapeBounds(top.shape) : null,
        totalArea: result.reduce((sum, item) => sum + shapeArea(item.shape), 0),
      };
    }

    function countCoincidentBounds(items) {
      const bounds = items.map(item => shapeBounds(item.shape));
      let pairs = 0;
      for (let i = 0; i < bounds.length; i++) {
        for (let j = i + 1; j < bounds.length; j++) {
          if (items[i].elementId === items[j].elementId) continue;
          if (
            Math.abs(bounds[i].minX - bounds[j].minX) <= 0.00011 &&
            Math.abs(bounds[i].maxX - bounds[j].maxX) <= 0.00011 &&
            Math.abs(bounds[i].minY - bounds[j].minY) <= 0.00011 &&
            Math.abs(bounds[i].maxY - bounds[j].maxY) <= 0.00011
          ) pairs++;
        }
      }
      return pairs;
    }

    function inspect3MFModel(modelXml) {
      const xml = new DOMParser().parseFromString(modelXml, 'application/xml');
      if (xml.querySelector('parsererror')) throw new Error('El XML interno del 3MF no es válido.');
      const objects = [...xml.getElementsByTagName('object')]
        .filter(object => object.getElementsByTagName('mesh').length > 0);
      let triangleCount = 0;
      let nonManifoldEdges = 0;
      let inconsistentWindingEdges = 0;
      let nonPositiveVolumes = 0;

      objects.forEach(object => {
        const edgeCounts = new Map();
        const edgeBalance = new Map();
        const vertices = [...object.getElementsByTagName('vertex')].map(vertex =>
          ['x', 'y', 'z'].map(axis => Number(vertex.getAttribute(axis)))
        );
        const triangles = [...object.getElementsByTagName('triangle')];
        let signedVolume = 0;
        triangleCount += triangles.length;
        triangles.forEach(triangle => {
          const refs = [1, 2, 3].map(i => Number(triangle.getAttribute('v' + i)));
          [[0, 1], [1, 2], [2, 0]].forEach(([a, b]) => {
            const left = refs[a];
            const right = refs[b];
            const edge = left < right ? left + ':' + right : right + ':' + left;
            edgeCounts.set(edge, (edgeCounts.get(edge) || 0) + 1);
            edgeBalance.set(
              edge,
              (edgeBalance.get(edge) || 0) + (left < right ? 1 : -1)
            );
          });
          const [a, b, c] = refs.map(index => vertices[index]);
          signedVolume += (
            a[0] * (b[1] * c[2] - b[2] * c[1]) -
            a[1] * (b[0] * c[2] - b[2] * c[0]) +
            a[2] * (b[0] * c[1] - b[1] * c[0])
          ) / 6;
        });
        nonManifoldEdges += [...edgeCounts.values()].filter(count => count !== 2).length;
        inconsistentWindingEdges += [...edgeBalance.values()]
          .filter(balance => balance !== 0).length;
        if (signedVolume <= 1e-9) nonPositiveVolumes++;
      });

      const componentObjects = [...xml.getElementsByTagName('object')]
        .filter(object => object.getElementsByTagName('components').length > 0);
      return {
        objectCount: objects.length,
        componentObjectCount: componentObjects.length,
        rootComponentCount: componentObjects.reduce(
          (sum, object) => sum + object.getElementsByTagName('component').length,
          0
        ),
        buildItemCount: xml.getElementsByTagName('item').length,
        colorCount: xml.getElementsByTagName('m:color').length ||
          xml.getElementsByTagName('color').length,
        triangleCount,
        nonManifoldEdges,
        inconsistentWindingEdges,
        nonPositiveVolumes,
      };
    }

    async function importThroughFileInput(text, filename) {
      const input = document.getElementById('file-input');
      const transfer = new DataTransfer();
      transfer.items.add(new File([text], filename, {
        type: filename.endsWith('.svg') ? 'image/svg+xml' : 'application/dxf',
      }));
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));

      const expectedName = filename.replace(/\.(dxf|svg)$/i, '');
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        if (State.filename === expectedName && State.contours.length) return;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      throw new Error(filename + ': la importación por la interfaz no terminó.');
    }

    function wait(ms) {
      return new Promise(resolve => setTimeout(resolve, ms));
    }

    function rounded(value) {
      return Number(Number(value).toFixed(6));
    }

    function meshSignature(mesh) {
      const geometry = mesh?.geometry;
      const positions = geometry?.attributes?.position;
      if (!positions) return null;
      geometry.computeBoundingBox();
      const box = geometry.boundingBox;
      return {
        vertices: positions.count,
        indices: geometry.index?.count || 0,
        bounds: [
          box.min.x, box.min.y, box.min.z,
          box.max.x, box.max.y, box.max.z,
        ].map(rounded),
      };
    }

    function flatSignatures() {
      return State.contours.map(contour => meshSignature(contour.flatMesh));
    }

    function voidStateSignature() {
      return State.contours
        .map((contour, index) => contour._isVoid ? {
          index,
          kind: contour._voidKind,
          area: rounded(contour._voidArea),
          synthetic: !!contour._syntheticVoid,
        } : null)
        .filter(Boolean);
    }

    function pieceSignature(piece) {
      if (!piece) return null;
      const box = GeoModule.getPieceRealBox(piece);
      return {
        mesh: meshSignature(piece.mesh),
        depth: rounded(piece._depth),
        holeIdxs: [...(piece._holeIdxs || [])].sort((a, b) => a - b),
        solidIslandIdxs: [...(piece._solidIslandIdxs || [])].sort((a, b) => a - b),
        sourceContourIdx: piece._sourceContourIdx,
        worldY: [rounded(box.min.y), rounded(box.max.y)],
      };
    }

    function extrusionSignature(contourIdx) {
      return pieceSignature(State.contours[contourIdx]?.piece);
    }

    function selectionIsCoherent() {
      return State.contours.every((contour, idx) => {
        const selected = State.selectedIdxs.has(idx);
        if (!Utils.isVisibleContour(contour)) return !selected;
        if (!contour.extruded && contour.sel2D !== selected) return false;
        if (selected && !State.selectedFaces.has(idx)) return false;
        return true;
      });
    }

    function clickContourPoint(contour, point) {
      const canvas = document.getElementById('viewport');
      const rect = canvas.getBoundingClientRect();
      const world = new THREE.Vector3(
        point.x - contour.offX,
        0.05,
        -(point.y - contour.offY)
      );
      const projected = world.project(Viewport.getCamera());
      canvas.dispatchEvent(new MouseEvent('click', {
        bubbles: true,
        button: 0,
        clientX: rect.left + (projected.x + 1) * rect.width / 2,
        clientY: rect.top + (1 - projected.y) * rect.height / 2,
      }));
      return [...State.selectedIdxs];
    }

    function clickPieceFacePoint(contour, point, face = 'top') {
      const piece = contour?.piece;
      if (!piece?.mesh) return [];
      const canvas = document.getElementById('viewport');
      const rect = canvas.getBoundingClientRect();
      piece.mesh.updateMatrixWorld(true);
      const localZ = face === 'bottom' ? 0 : Math.abs(piece._depth || 0.1);
      const world = piece.mesh.localToWorld(new THREE.Vector3(point.x, point.y, localZ));
      const projected = world.project(Viewport.getCamera());
      canvas.dispatchEvent(new MouseEvent('click', {
        bubbles: true,
        button: 0,
        clientX: rect.left + (projected.x + 1) * rect.width / 2,
        clientY: rect.top + (1 - projected.y) * rect.height / 2,
      }));
      return [...State.selectedIdxs];
    }

    // Un punto interior garantizado del shape (con sus holes), vía el mismo
    // triangulador que usa ShapeGeometry/ExtrudeGeometry: el centroide de
    // cualquier triángulo de una triangulación válida cae siempre adentro,
    // a diferencia del centroide del polígono completo (puede caer afuera
    // en una forma cóncava, ej. una letra).
    function interiorPoint(shape) {
      const outerPts = shape.getPoints(64);
      const holePts = (shape.holes || []).map(h => h.getPoints(64));
      const tris = THREE.ShapeUtils.triangulateShape(outerPts, holePts);
      if (!tris.length) return null;
      const flat = outerPts.concat(...holePts);
      const [ia, ib, ic] = tris[0];
      const a = flat[ia], b = flat[ib], c = flat[ic];
      return { x: (a.x + b.x + c.x) / 3, y: (a.y + b.y + c.y) / 3 };
    }

    // Busca, entre los contornos 2D todavia sin extruir, un par que ocupe
    // exactamente el mismo lugar fisico -- el borde de hueco que resolve()
    // expone como su propia pieza (_itemInternalHole, ver GeoModule.makeFlat)
    // y el contorno real que ocupa ese lugar (findSameSizeTwin en PanelUI).
    // Generico: no asume indices fijos de ningun fixture en particular.
    function findGhostRealPair(contours) {
      const tol = 0.0011;
      for (let i = 0; i < contours.length; i++) {
        const a = contours[i];
        if (!a?.shape || a.extruded || !Utils.isVisibleContour(a)) continue;
        for (let j = i + 1; j < contours.length; j++) {
          const b = contours[j];
          if (!b?.shape || b.extruded || !Utils.isVisibleContour(b)) continue;
          if (!!a._itemInternalHole === !!b._itemInternalHole) continue;
          const boundsA = shapeBounds(a.shape);
          const boundsB = shapeBounds(b.shape);
          const coincide =
            Math.abs(boundsA.minX - boundsB.minX) <= tol &&
            Math.abs(boundsA.maxX - boundsB.maxX) <= tol &&
            Math.abs(boundsA.minY - boundsB.minY) <= tol &&
            Math.abs(boundsA.maxY - boundsB.maxY) <= tol;
          if (!coincide) continue;
          return a._itemInternalHole
            ? { ghostIdx: i, realIdx: j }
            : { ghostIdx: j, realIdx: i };
        }
      }
      return null;
    }

    function clickObjectTriangleCenter(object) {
      const geometry = object?.geometry;
      const positions = geometry?.attributes?.position;
      if (!positions?.count) return [];
      const index = geometry.index;
      const refs = index && index.count >= 3
        ? [index.getX(0), index.getX(1), index.getX(2)]
        : [0, 1, 2];
      const local = refs.reduce(
        (sum, vertexIdx) => sum.add(new THREE.Vector3(
          positions.getX(vertexIdx),
          positions.getY(vertexIdx),
          positions.getZ(vertexIdx)
        )),
        new THREE.Vector3()
      ).multiplyScalar(1 / 3);
      object.updateWorldMatrix(true, false);
      const world = object.localToWorld(local);
      const projected = world.project(Viewport.getCamera());
      const canvas = document.getElementById('viewport');
      const rect = canvas.getBoundingClientRect();
      canvas.dispatchEvent(new MouseEvent('click', {
        bubbles: true,
        button: 0,
        clientX: rect.left + (projected.x + 1) * rect.width / 2,
        clientY: rect.top + (1 - projected.y) * rect.height / 2,
      }));
      return [...State.selectedIdxs];
    }

    function findNearBoundaryFacePick() {
      for (let parentIdx = 0; parentIdx < State.contours.length; parentIdx++) {
        const parent = State.contours[parentIdx];
        if (!Utils.isVisibleContour(parent) || parent.extruded || parent.depth % 2 === 1) continue;
        const childIdx = State.contours.findIndex((candidate, idx) =>
          idx !== parentIdx &&
          Utils.isVisibleContour(candidate) &&
          candidate.parentIdx === parentIdx &&
          candidate.depth === parent.depth + 1
        );
        if (childIdx === -1) continue;

        const child = State.contours[childIdx];
        const childPoints = child.shape.getPoints(128);
        const parentPoints = parent.shape.getPoints(128);
        for (let i = 0; i < childPoints.length; i += 4) {
          const a = childPoints[i];
          const b = childPoints[(i + 1) % childPoints.length];
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const len = Math.hypot(dx, dy);
          if (len < 1e-8) continue;
          const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
          const normal = { x: -dy / len, y: dx / len };

          for (const distance of [0.04, 0.08, 0.16, 0.3]) {
            for (const sign of [-1, 1]) {
              const point = {
                x: mid.x + normal.x * distance * sign,
                y: mid.y + normal.y * distance * sign,
              };
              const insideParent = Utils.pointInPolygon(point.x, point.y, parentPoints);
              const insideChild = Utils.pointInPolygon(point.x, point.y, childPoints);
              if (!insideParent || insideChild) continue;
              const selected = clickContourPoint(parent, point);
              if (selected.length === 1 && selected[0] === parentIdx) {
                return { parentIdx, childIdx, point };
              }
            }
          }
        }
      }
      return null;
    }

    function navigationState() {
      if (typeof Viewport.getNavigationState === 'function') {
        return Viewport.getNavigationState();
      }
      const camera = Viewport.getCamera();
      return {
        position: camera.position.toArray(),
        quaternion: camera.quaternion.toArray(),
        zoom: camera.zoom,
      };
    }

    function maxArrayDelta(a = [], b = []) {
      return Math.max(0, ...a.map((value, idx) => Math.abs(value - (b[idx] ?? value))));
    }

    function navigationDelta(a, b) {
      return Math.max(
        maxArrayDelta(a.position, b.position),
        maxArrayDelta(a.quaternion, b.quaternion),
        maxArrayDelta(a.target, b.target),
        Math.abs((a.zoom ?? 1) - (b.zoom ?? 1))
      );
    }

    async function testUndoRedoExtrusion() {
      await importThroughFileInput(dxfText, 'tucan-history.dxf');
      await wait(550);
      const initialFlat = flatSignatures();
      const initialVoids = voidStateSignature();
      const nearBoundary = findNearBoundaryFacePick();
      if (!nearBoundary) throw new Error('No se encontró una cara seleccionable cerca de un contorno.');

      document.getElementById('ex-depth').value = '3';
      document.getElementById('ex-bevel').value = '0';
      document.getElementById('btn-extrude').click();
      const firstExtrusion = extrusionSignature(nearBoundary.parentIdx);

      document.getElementById('btn-undo').click();
      const afterUndoFlat = flatSignatures();
      const afterUndoVoids = voidStateSignature();
      const afterUndoSelectionCoherent = selectionIsCoherent();
      const secondPick = clickContourPoint(
        State.contours[nearBoundary.parentIdx],
        nearBoundary.point
      );
      document.getElementById('btn-extrude').click();
      const secondExtrusion = extrusionSignature(nearBoundary.parentIdx);
      const redoDiscardedAfterNewExtrusion = !History.canRedo();

      document.getElementById('btn-undo').click();
      document.getElementById('btn-redo').click();
      const redoneExtrusion = extrusionSignature(nearBoundary.parentIdx);

      return {
        parentIdx: nearBoundary.parentIdx,
        childIdx: nearBoundary.childIdx,
        firstPick: nearBoundary.parentIdx,
        secondPick,
        initialFlat,
        afterUndoFlat,
        initialVoids,
        afterUndoVoids,
        afterUndoSelectionCoherent,
        firstExtrusion,
        secondExtrusion,
        redoneExtrusion,
        redoDiscardedAfterNewExtrusion,
      };
    }

    async function test3DFaceUndoRedo(mode) {
      await importThroughFileInput(dxfText, 'tucan-3d-history-' + mode + '.dxf');
      await wait(50);
      const nearBoundary = findNearBoundaryFacePick();
      if (!nearBoundary) throw new Error('No se encontró una cara 3D de prueba junto a un contorno.');

      PanelUI.clearAllSelection();
      if (mode === 'merged') {
        State.contours.forEach((contour, idx) => {
          if (!Utils.isVisibleContour(contour) || contour.depth % 2 === 1) return;
          State.selectedIdxs.add(idx);
          State.selectedFaces.set(idx, 'top');
          contour.sel2D = true;
        });
      } else {
        PanelUI.selectOne(nearBoundary.parentIdx, false, undefined, 'top');
      }
      State.extrudeMode = mode;
      document.getElementById('ex-depth').value = '3';
      document.getElementById('ex-bevel').value = '0';
      PanelUI.updateButtons();
      document.getElementById('btn-extrude').click();

      const parent = State.contours[nearBoundary.parentIdx];
      const firstPick = clickPieceFacePoint(parent, nearBoundary.point);
      document.getElementById('btn-extrude').click();
      const firstLayer = pieceSignature(State.pieces[State.pieces.length - 1]);

      document.getElementById('btn-undo').click();
      const restoredParent = State.contours[nearBoundary.parentIdx];
      const secondPick = clickPieceFacePoint(restoredParent, nearBoundary.point);
      document.getElementById('btn-extrude').click();
      const secondLayer = pieceSignature(State.pieces[State.pieces.length - 1]);

      document.getElementById('btn-undo').click();
      document.getElementById('btn-redo').click();
      const redoneLayer = pieceSignature(State.pieces[State.pieces.length - 1]);

      return {
        mode,
        parentIdx: nearBoundary.parentIdx,
        firstPick,
        secondPick,
        firstLayer,
        secondLayer,
        redoneLayer,
        coherent: selectionIsCoherent(),
      };
    }

    async function testVisibilityUndoRedo() {
      await importThroughFileInput(dxfText, 'tucan-visibility-history.dxf');
      const solidIdxs = State.contours
        .map((contour, idx) => ({ contour, idx }))
        .filter(({ contour }) => Utils.isVisibleContour(contour) && contour.depth % 2 === 0)
        .slice(0, 2)
        .map(({ idx }) => idx);
      PanelUI.clearAllSelection();
      solidIdxs.forEach(idx => PanelUI.selectOne(idx, true, undefined, 'top'));
      State.extrudeMode = 'separate';
      document.getElementById('btn-extrude').click();

      const targetIdx = solidIdxs[0];
      const otherIdx = solidIdxs[1];
      PanelUI.selectOne(targetIdx, false, undefined, 'top');
      document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'h' }));
      const hiddenAfterAction = State.contours[targetIdx].piece?.mesh.visible === false;
      document.getElementById('btn-undo').click();
      const visibleAfterUndo = State.contours[targetIdx].piece?.mesh.visible !== false;
      document.getElementById('btn-redo').click();
      const hiddenAfterRedo = State.contours[targetIdx].piece?.mesh.visible === false;

      document.getElementById('btn-undo').click();
      PanelUI.selectOne(targetIdx, false, undefined, 'top');
      document.dispatchEvent(new KeyboardEvent('keydown', {
        bubbles: true, key: 'i', altKey: true,
      }));
      const isolatedAfterAction =
        State.contours[targetIdx].piece?.mesh.visible !== false &&
        State.contours[otherIdx].piece?.mesh.visible === false;
      document.getElementById('btn-undo').click();
      const allVisibleAfterUndo = solidIdxs.every(
        idx => State.contours[idx].piece?.mesh.visible !== false
      );
      document.getElementById('btn-redo').click();
      const isolatedAfterRedo =
        State.contours[targetIdx].piece?.mesh.visible !== false &&
        State.contours[otherIdx].piece?.mesh.visible === false;

      return {
        hiddenAfterAction,
        visibleAfterUndo,
        hiddenAfterRedo,
        isolatedAfterAction,
        allVisibleAfterUndo,
        isolatedAfterRedo,
        coherent: selectionIsCoherent(),
      };
    }

    async function testAdditionalHistoryOperations() {
      await importThroughFileInput(dxfText, 'tucan-other-history.dxf');
      const nearBoundary = findNearBoundaryFacePick();
      if (!nearBoundary) throw new Error('No se encontró la pieza para auditar operaciones de historial.');

      document.getElementById('ex-depth').value = '3';
      document.getElementById('ex-bevel').value = '0';
      document.getElementById('btn-extrude').click();
      clickPieceFacePoint(State.contours[nearBoundary.parentIdx], nearBoundary.point);
      document.getElementById('btn-extrude').click();

      const layerPiece = State.pieces[State.pieces.length - 1];
      const layerIdx = layerPiece.contourIdx;
      PanelUI.selectOne(layerIdx, false, undefined, 'top');
      document.dispatchEvent(new KeyboardEvent('keydown', {
        bubbles: true, key: 'd', ctrlKey: true,
      }));
      const duplicateAfterAction = pieceSignature(State.pieces[State.pieces.length - 1]);
      const countAfterDuplicate = State.pieces.length;
      document.getElementById('btn-undo').click();
      const countAfterDuplicateUndo = State.pieces.length;
      document.getElementById('btn-redo').click();
      const duplicateAfterRedo = pieceSignature(State.pieces[State.pieces.length - 1]);

      const duplicatePiece = State.pieces[State.pieces.length - 1];
      const duplicateIdx = State.contours.findIndex(contour =>
        contour.piece === duplicatePiece && !contour._panelHidden
      );
      PanelUI.selectOne(duplicateIdx, false, undefined, 'top');
      document.dispatchEvent(new KeyboardEvent('keydown', {
        bubbles: true, key: 'Delete',
      }));
      const countAfterDelete = State.pieces.length;
      document.getElementById('btn-undo').click();
      const countAfterDeleteUndo = State.pieces.length;
      document.getElementById('btn-redo').click();
      const countAfterDeleteRedo = State.pieces.length;

      document.getElementById('btn-undo').click();
      const ownerIdxs = State.pieces.slice(0, 2).map(piece =>
        State.contours.findIndex(contour => contour.piece === piece && !contour._panelHidden)
      );
      PanelUI.clearAllSelection();
      ownerIdxs.forEach(idx => PanelUI.selectOne(idx, true, undefined, 'top'));
      const colorsBefore = ownerIdxs.map(idx => State.contours[idx].piece.color);
      PanelUI.applyColorToSelection('#2468ac', true);
      const colorsAfterAction = ownerIdxs.map(idx => State.contours[idx].piece.color);
      document.getElementById('btn-undo').click();
      const colorsAfterUndo = ownerIdxs.map(idx => State.contours[idx].piece.color);
      document.getElementById('btn-redo').click();
      const colorsAfterRedo = ownerIdxs.map(idx => State.contours[idx].piece.color);

      PanelUI.clearAllSelection();
      ownerIdxs.forEach(idx => PanelUI.selectOne(idx, true, undefined, 'top'));
      // Agrupar es la tecla G sola desde que Ctrl+G pasó a ser Guardar.
      document.dispatchEvent(new KeyboardEvent('keydown', {
        bubbles: true, key: 'g',
      }));
      const groupsAfterAction = State.groups.length;
      document.getElementById('btn-undo').click();
      const groupsAfterUndo = State.groups.length;
      document.getElementById('btn-redo').click();
      const groupsAfterRedo = State.groups.length;

      return {
        duplicateAfterAction,
        duplicateAfterRedo,
        countAfterDuplicate,
        countAfterDuplicateUndo,
        countAfterDelete,
        countAfterDeleteUndo,
        countAfterDeleteRedo,
        colorsBefore,
        colorsAfterAction,
        colorsAfterUndo,
        colorsAfterRedo,
        groupsAfterAction,
        groupsAfterUndo,
        groupsAfterRedo,
        coherent: selectionIsCoherent(),
      };
    }

    async function testSelectionSnapshot() {
      await importThroughFileInput(dxfText, 'tucan-selection-history.dxf');
      const selected = State.contours
        .map((contour, idx) => ({ contour, idx }))
        .filter(({ contour }) => Utils.isVisibleContour(contour) && !contour.extruded)
        .slice(0, 2)
        .map(({ idx }) => idx);
      PanelUI.clearAllSelection();
      selected.forEach(idx => PanelUI.selectOne(idx, true, undefined, 'top'));
      History.push(State);
      PanelUI.clearAllSelection();
      History.push(State);
      document.getElementById('btn-undo').click();
      return {
        expected: selected,
        restored: [...State.selectedIdxs].sort((a, b) => a - b),
        faces: [...State.selectedFaces.entries()].sort((a, b) => a[0] - b[0]),
        coherent: selectionIsCoherent(),
      };
    }

    async function testCameraImport() {
      await importThroughFileInput(dxfText, 'tucan-camera-before.dxf');
      await wait(550);
      const canvas = document.getElementById('viewport');
      const rect = canvas.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      canvas.dispatchEvent(new MouseEvent('mousedown', {
        bubbles: true, button: 2, clientX: cx, clientY: cy,
      }));
      window.dispatchEvent(new MouseEvent('mousemove', {
        bubbles: true, button: 2, clientX: cx + 90, clientY: cy - 45,
      }));
      window.dispatchEvent(new MouseEvent('mouseup', {
        bubbles: true, button: 2, clientX: cx + 90, clientY: cy - 45,
      }));
      await wait(50);

      const before = navigationState();
      await importThroughFileInput(svgText, 'tucan-camera-after.svg');
      const immediate = navigationState();
      await wait(650);
      const settled = navigationState();
      return {
        immediateDelta: navigationDelta(before, immediate),
        settledDelta: navigationDelta(before, settled),
        before,
        immediate,
        settled,
      };
    }

    /* Bloqueo de click en piezas 2D adyacentes al hueco de una letra (ver
       DECISIONS.md, 2026-08-05 seguimiento 4, punto 2: "sigue sin resolver
       ... clickear esa otra capa"). Un click sobre un contorno real ("el
       hueco de una letra", ej. Camem) no puede resolver al fantasma
       _itemInternalHole que ocupa exactamente el mismo lugar, aunque el
       fantasma no esté (todavía) en la misma acción de extrusión que su
       gemelo -- ese es justo el caso que el desempate por selección
       compartida (ver btn-extrude, findSameSizeTwin) no cubre, porque ahí
       no hay ninguna extrusión en curso todavía. */
    async function testAdjacentGhostPicking() {
      await importThroughFileInput(camemDxfText, 'camem-picking.dxf');
      await wait(300);

      const pair = findGhostRealPair(State.contours);
      if (!pair) throw new Error('Camem: no se encontró un par fantasma/gemelo para probar.');
      const { ghostIdx, realIdx } = pair;
      const realContour = State.contours[realIdx];
      // Mismo criterio que el handler de btn-extrude: color propio del
      // contorno o, si no tiene, el gris por defecto de extrusión.
      const designColor = realContour.color || '#c8c8d0';
      const point = interiorPoint(realContour.shape);
      if (!point) throw new Error('Camem: no se pudo triangular el contorno real para hallar un punto interior.');

      PanelUI.clearAllSelection();
      const pickBeforeExtrude = clickContourPoint(realContour, point);

      document.getElementById('ex-depth').value = '2';
      document.getElementById('ex-bevel').value = '0';
      document.getElementById('btn-extrude').click();

      return {
        ghostIdx,
        realIdx,
        pickBeforeExtrude,
        designColor,
        realExtruded: realContour.extruded,
        realPieceColor: realContour.piece ? realContour.piece.color : null,
        ghostUntouched: !State.contours[ghostIdx].extruded,
        piecesCreated: State.pieces.length,
      };
    }

    async function testViewportPanelSelectionSync() {
      await importThroughFileInput(dxfText, 'tucan-panel-selection.dxf');
      State.extrudeMode = 'merged';
      PanelUI.clearAllSelection();
      State.contours.forEach((contour, index) => {
        if (!Utils.isVisibleContour(contour) || contour.depth % 2 === 1) return;
        contour.sel2D = true;
        State.selectedIdxs.add(index);
        State.selectedFaces.set(index, 'top');
      });
      document.getElementById('ex-depth').value = '2';
      document.getElementById('ex-bevel').value = '0';
      PanelUI.updateButtons();
      document.getElementById('btn-extrude').click();

      const piece = State.pieces[0];
      const rowIdx = piece?.contourIdx;
      const pickAreas = [];
      piece?.mesh?.traverse(object => {
        const contourIdx = object.userData?._pickContourIdx;
        if (!object.isMesh ||
            contourIdx == null ||
            object.userData?._pickFace !== 'top' ||
            !State.contours[contourIdx]?._panelHidden) return;
        pickAreas.push(object);
      });
      pickAreas.sort((a, b) =>
        (a.userData._pickArea ?? Infinity) - (b.userData._pickArea ?? Infinity)
      );
      if (!piece || !Number.isInteger(rowIdx) || !pickAreas.length) {
        throw new Error('No se encontro una subcara oculta para probar la seleccion del panel.');
      }

      State.groups = [{
        id: State._nextGroupId++,
        name: 'Seleccion viewport',
        collapsed: true,
        memberIdxs: [rowIdx],
      }];
      PanelUI.clearAllSelection();
      PanelUI.renderList();
      const selected = clickObjectTriangleCenter(pickAreas[0]);
      await wait(30);
      const selectedIdx = selected[0] ?? -1;
      const row = document.querySelector('.piece-item[data-idx="' + rowIdx + '"]');

      return {
        selected,
        selectedIsHiddenSubface: selected.length === 1 &&
          !!State.contours[selectedIdx]?._panelHidden,
        samePiece: selected.length === 1 &&
          State.contours[selectedIdx]?.piece === piece,
        rowIdx,
        rowSelected: !!row?.classList.contains('sel-3d'),
        groupExpanded: State.groups[0]?.collapsed === false,
      };
    }

    function meshObjectBounds(modelXml) {
      const xml = new DOMParser().parseFromString(modelXml, 'application/xml');
      return [...xml.getElementsByTagName('object')]
        .filter(object => object.getElementsByTagName('mesh').length > 0)
        .map(object => {
          const vertices = [...object.getElementsByTagName('vertex')];
          const min = [Infinity, Infinity, Infinity];
          const max = [-Infinity, -Infinity, -Infinity];
          vertices.forEach(vertex => {
            ['x', 'y', 'z'].forEach((axis, axisIdx) => {
              const value = Number(vertex.getAttribute(axis));
              min[axisIdx] = Math.min(min[axisIdx], value);
              max[axisIdx] = Math.max(max[axisIdx], value);
            });
          });
          return { min, max };
        });
    }

    async function testExportClearance() {
      function rectangle(x1, y1, x2, y2) {
        const shape = new THREE.Shape();
        shape.moveTo(x1, y1);
        shape.lineTo(x2, y1);
        shape.lineTo(x2, y2);
        shape.lineTo(x1, y2);
        shape.closePath();
        return shape;
      }

      function makePiece(shape, name, color, baseY = 0) {
        const mesh = GeoModule.extrude(shape, 0, 0, {
          depth: 1,
          bevel: 0,
          bevelSeg: 1,
          color,
        });
        mesh.position.y += baseY;
        return GeoModule.makePiece({
          mesh,
          name,
          color,
          contourIdx: 0,
          sourceContourIdx: 0,
          depth: 1,
          bevel: 0,
          bevelSeg: 1,
          baseX: mesh.position.x,
          baseY: mesh.position.y,
          baseZ: mesh.position.z,
        });
      }

      const pieces = [
        makePiece(rectangle(0, 0, 10, 10), 'Base', '#ffffff'),
        makePiece(rectangle(10, 0, 20, 10), 'Lateral', '#ff8800'),
        makePiece(rectangle(0, 0, 10, 10), 'Superior', '#222222', 1),
      ];
      const toggle = document.getElementById('btn-export-gap');
      const input = document.getElementById('export-gap-value');
      const exportButton = document.getElementById('btn-export');
      const toggleInitial = toggle?.getAttribute('aria-checked');
      const inputInitial = input?.value;
      let customUiClearance = null;
      const originalExportMeshes = Exporter.exportMeshes;
      if (input) {
        input.value = '0,0025';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      toggle?.click();
      const toggleEnabled = toggle?.getAttribute('aria-checked');
      try {
        Exporter.exportMeshes = async (exportPieces, filename, options) => {
          customUiClearance = options?.clearanceMm ?? null;
          return {
            failedCount: 0,
            totalCount: exportPieces.length,
            filename,
          };
        };
        exportButton?.click();
        await new Promise(resolve => setTimeout(resolve, 20));
      } finally {
        Exporter.exportMeshes = originalExportMeshes;
      }
      toggle?.click();
      const toggleRestored = toggle?.getAttribute('aria-checked');
      if (input) {
        input.value = '0,001';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('blur'));
      }
      const pieceSignaturesBefore = pieces.map(pieceSignature);
      const plain = await Exporter.generate3MFBlob(
        pieces,
        'clearance-off',
        { clearanceMm: 0 }
      );
      const cleared = await Exporter.generate3MFBlob(
        pieces,
        'clearance-on',
        { clearanceMm: 0.001 }
      );
      const plainZip = await JSZip.loadAsync(plain.blob);
      const clearedZip = await JSZip.loadAsync(cleared.blob);
      const plainXml = await plainZip.file('3D/3dmodel.model').async('string');
      const clearedXml = await clearedZip.file('3D/3dmodel.model').async('string');
      const plainBounds = meshObjectBounds(plainXml);
      const clearedBounds = meshObjectBounds(clearedXml);
      const pieceSignaturesAfter = pieces.map(pieceSignature);

      return {
        toggleInitial,
        toggleEnabled,
        toggleRestored,
        inputInitial,
        inputRestored: input?.value,
        inputValid: input?.getAttribute('aria-invalid'),
        customUiClearance,
        optionOff: plain.clearanceMm,
        optionOn: cleared.clearanceMm,
        plainSideGap: rounded(plainBounds[1].min[0] - plainBounds[0].max[0]),
        clearedSideGap: rounded(clearedBounds[1].min[0] - clearedBounds[0].max[0]),
        plainVerticalGap: rounded(plainBounds[2].min[2] - plainBounds[0].max[2]),
        clearedVerticalGap: rounded(clearedBounds[2].min[2] - clearedBounds[0].max[2]),
        modelUnchanged:
          JSON.stringify(pieceSignaturesBefore) === JSON.stringify(pieceSignaturesAfter),
        clearedTopology: inspect3MFModel(clearedXml),
      };
    }

    /* Diseño por capas denso: verifica que DXF y SVG lleguen a la misma
       semantica de vacios (un unico hueco real), que todo contorno con
       material quede seleccionable, y que "seleccionar todo + extruir"
       termine en las dos modalidades sin abortar y en tiempo razonable.
       Antes de este caso, el DXF clasificaba decenas de piezas internas
       como vacios y la extrusion unida podia tardar minutos o abortar. */
    async function testLayeredArtwork(text, name, extension) {
      await importThroughFileInput(text, name + extension);
      const contours = State.contours.length;
      const voids = State.contours.filter(contour => contour._isVoid).length;
      const selectable = State.contours.filter(contour =>
        Utils.isVisibleContour(contour)
      ).length;
      const colors = new Set(
        State.contours.map(contour => contour.color).filter(Boolean)
      ).size;

      const modes = {};
      for (const mode of ['separate', 'merged']) {
        await importThroughFileInput(text, name + '-' + mode + extension);
        PanelUI.selectAll();
        State.extrudeMode = mode;
        document.getElementById('ex-depth').value = '3';
        document.getElementById('ex-bevel').value = '0';
        PanelUI.updateButtons();
        const started = performance.now();
        document.getElementById('btn-extrude').click();
        const elapsedMs = performance.now() - started;
        const invalidMeshes = State.pieces.filter(piece => {
          const positions = piece.mesh?.geometry?.attributes?.position;
          return !positions || positions.count < 3 ||
            !Number.isFinite(GeoModule.getPieceRealBox(piece).min.x);
        }).length;
        modes[mode] = {
          elapsedMs: Math.round(elapsedMs),
          pieces: State.pieces.length,
          invalidMeshes,
        };
        // El contrato 3MF se exige sobre el solido canonico del modo unido.
        // En modo separado, el contorno base de este diseño se extruye con
        // ~60 huecos seleccionados y todavia produce una malla abierta: es un
        // defecto anterior a la union por pares (ver DECISIONS.md) y no se
        // congela aca como si estuviera resuelto.
        if (mode !== 'merged') continue;
        const generated = await Exporter.generate3MFBlob(State.pieces, name);
        const zip = await JSZip.loadAsync(generated.blob);
        const modelFile = Object.keys(zip.files)
          .find(filename => /3dmodel\\.model$/i.test(filename));
        const model = inspect3MFModel(await zip.file(modelFile).async('string'));
        Object.assign(modes[mode], {
          failedExports: generated.failedCount,
          nonManifoldEdges: model.nonManifoldEdges,
          inconsistentWindingEdges: model.inconsistentWindingEdges,
          nonPositiveVolumes: model.nonPositiveVolumes,
        });
      }
      return { contours, voids, selectable, colors, modes };
    }

    /* Reimportacion de un modelo exportado. Cubre los dos caminos:

       - con proyecto incrustado, el archivo vuelve identico al original
         (mismos contornos, mismas piezas, mismos colores);
       - sin el, la pieza se reconstruye desde la malla y tienen que
         coincidir la cantidad de piezas, sus colores, su altura y su
         huella 2D. Esa es la unica prueba de que la union de triangulos
         proyectados devuelve el perfil y no una silueta cualquiera.

       Se corre sobre el Tucan en modo separado: varias piezas, varios
       colores y un hueco real. */
    async function testModelImportRoundTrip(text, name, extension) {
      await importThroughFileInput(text, name + extension);
      PanelUI.selectAll();
      State.extrudeMode = 'separate';
      document.getElementById('ex-depth').value = '3';
      document.getElementById('ex-bevel').value = '0';
      PanelUI.updateButtons();
      document.getElementById('btn-extrude').click();

      const payload = JSON.stringify(window.inkoraProject.buildPayload());
      const originalPieces = State.pieces.length;
      const originalContours = State.contours.length;
      const originalColors = [...new Set(State.pieces.map(piece => piece.color))].sort();

      function measure(pieces) {
        const box = new THREE.Box3();
        pieces.forEach(piece => box.expandByObject(piece.mesh));
        const size = box.getSize(new THREE.Vector3());
        return [rounded(size.x), rounded(size.y), rounded(size.z)];
      }
      const originalSize = measure(State.pieces);

      // 1. 3MF con proyecto incrustado.
      const embedded3MF = await Exporter.generate3MFBlob(State.pieces, name, {
        clearanceMm: 0,
        embeddedProject: payload,
      });
      const embeddedZip = await JSZip.loadAsync(embedded3MF.blob);
      const embeddedRead = await MeshImport.read3MF(await embedded3MF.blob.arrayBuffer());

      // 2. 3MF sin incrustar: reconstruccion desde la malla.
      const plain3MF = await Exporter.generate3MFBlob(State.pieces, name, { clearanceMm: 0 });
      const plainRead = await MeshImport.read3MF(await plain3MF.blob.arrayBuffer());
      const rebuilt = MeshImport.meshesToSnapshot(plainRead.meshes, name);

      // 3. OBJ, los dos caminos.
      const embeddedOBJ = Exporter.generateOBJFiles(State.pieces, name, {
        clearanceMm: 0,
        embeddedProject: payload,
      });
      const objEmbeddedRead = MeshImport.readOBJ(embeddedOBJ.objText, embeddedOBJ.mtlText);
      const plainOBJ = Exporter.generateOBJFiles(State.pieces, name, { clearanceMm: 0 });
      const objPlainRead = MeshImport.readOBJ(plainOBJ.objText, plainOBJ.mtlText);
      const objRebuilt = MeshImport.meshesToSnapshot(objPlainRead.meshes, name);

      /* Restaurar de verdad el proyecto incrustado. Es el mismo camino que
         abrir un .inkora3d guardado, y el unico que ejercita la restauracion
         de piezas cuyo "hueco" registrado tiene la misma area que su padre:
         al extruir, enclosesInterior() lo descarta, pero el indice queda en
         _holeIdxs. Sin ese mismo filtro al restaurar, la resta deja la pieza
         sin material y la escena entera se cae en la primera pieza. */
      window.inkoraProject.open(embeddedRead.project.snapshot, { name, dirty: true });
      const restoredPieces = State.pieces.length;
      const restoredColors = [...new Set(State.pieces.map(piece => piece.color))].sort();
      const restoredSize = measure(State.pieces);

      // Reconstruir de verdad la escena desde la malla del 3MF y medirla:
      // el snapshot solo prueba que los numeros salen, no que la geometria
      // vuelva a armarse.
      window.inkoraProject.open(rebuilt.snapshot, { name, dirty: true });
      const rebuiltPieces = State.pieces.length;
      const rebuiltColors = [...new Set(State.pieces.map(piece => piece.color))].sort();
      const rebuiltSize = measure(State.pieces);

      return {
        originalPieces,
        originalContours,
        originalColors,
        originalSize,
        embedded3MFPartPresent: !!embeddedZip.file('Metadata/INKORA/project.json'),
        embedded3MFProjectPieces: embeddedRead.project
          ? embeddedRead.project.snapshot.contours.filter(c => c.pieceData).length
          : 0,
        embedded3MFProjectContours: embeddedRead.project
          ? embeddedRead.project.snapshot.contours.length
          : 0,
        plain3MFMeshCount: plainRead.meshes.length,
        plain3MFHasProject: !!plainRead.project,
        objEmbeddedProjectContours: objEmbeddedRead.project
          ? objEmbeddedRead.project.snapshot.contours.length
          : 0,
        objPlainMeshCount: objPlainRead.meshes.length,
        objRebuiltPieces: objRebuilt.snapshot.contours.filter(c => c.pieceData).length,
        restoredPieces,
        restoredColors,
        restoredSize,
        rebuiltPieces,
        rebuiltColors,
        rebuiltSize,
        rebuiltSkipped: rebuilt.skipped.length,
      };
    }

    /* Serializador OBJ. Comparte con el 3MF la etapa geometrica, asi que
       aca no se re-valida la malla: se valida lo que es exclusivo del
       formato y no lo cubre ningun otro test.

       Los indices de OBJ son globales al archivo y 1-based, no por objeto
       como en 3MF. Un offset mal acumulado produce un archivo que abre sin
       error pero con la geometria mezclada, asi que se revisa rango,
       cierre por grupo y correspondencia con el .mtl. */
    async function testOBJExport(text, name, extension) {
      await importThroughFileInput(text, name + extension);
      PanelUI.selectAll();
      State.extrudeMode = 'separate';
      document.getElementById('ex-depth').value = '3';
      document.getElementById('ex-bevel').value = '0';
      PanelUI.updateButtons();
      document.getElementById('btn-extrude').click();

      const obj = Exporter.generateOBJFiles(State.pieces, name, { clearanceMm: 0 });
      const threeMF = await Exporter.generate3MFBlob(State.pieces, name, { clearanceMm: 0 });

      const vertices = [];
      const faces = [];
      const groups = [];
      const usedMaterials = new Set();
      let mtllib = null;
      obj.objText.split('\\n').forEach(line => {
        if (line.startsWith('v ')) vertices.push(line.slice(2).split(' ').map(Number));
        else if (line.startsWith('f ')) faces.push(line.slice(2).split(' ').map(Number));
        else if (line.startsWith('g ')) groups.push({ start: faces.length });
        else if (line.startsWith('usemtl ')) usedMaterials.add(line.slice(7).trim());
        else if (line.startsWith('mtllib ')) mtllib = line.slice(7).trim();
      });
      const declared = [...obj.mtlText.matchAll(/^newmtl (.+)$/gm)].map(match => match[1].trim());

      let outOfRange = 0;
      let degenerate = 0;
      faces.forEach(face => {
        if (face.length !== 3) outOfRange++;
        face.forEach(index => {
          if (!Number.isInteger(index) || index < 1 || index > vertices.length) outOfRange++;
        });
        if (face[0] === face[1] || face[1] === face[2] || face[0] === face[2]) degenerate++;
      });

      // El cierre se mide por grupo: piezas adyacentes comparten frontera
      // exacta por invariante del pipeline, asi que soldar todo el archivo
      // junto reportaria aristas de cuatro caras que no son un defecto.
      const vertexKey = index => vertices[index - 1]
        .map(value => Math.round(value * 1e5)).join(',');
      let openEdges = 0;
      let overusedEdges = 0;
      groups.forEach((group, index) => {
        const end = index + 1 < groups.length ? groups[index + 1].start : faces.length;
        const uses = new Map();
        for (let face = group.start; face < end; face++) {
          const [a, b, c] = faces[face].map(vertexKey);
          [[a, b], [b, c], [c, a]].forEach(([from, to]) => {
            const key = from < to ? from + '|' + to : to + '|' + from;
            uses.set(key, (uses.get(key) || 0) + 1);
          });
        }
        uses.forEach(count => {
          if (count === 1) openEdges++;
          else if (count > 2) overusedEdges++;
        });
      });

      return {
        pieces: State.pieces.length,
        groups: groups.length,
        vertices: vertices.length,
        declaredVertices: obj.vertexCount,
        faces: faces.length,
        mtllibMatchesFilename: mtllib === obj.mtlFilename,
        missingMaterials: [...usedMaterials].filter(m => !declared.includes(m)).length,
        unusedMaterials: declared.filter(m => !usedMaterials.has(m)).length,
        outOfRange,
        degenerate,
        openEdges,
        overusedEdges,
        colorParityWith3MF: obj.colorCount === threeMF.colorCount,
      };
    }

    async function testFullFlow(parser, text, name) {
      const shapeData = await parser.loadText(text);
      const coincidentBoundaryPairs = countCoincidentBounds(shapeData);
      const extension = parser === SVGParser ? '.svg' : '.dxf';
      await importThroughFileInput(text, name + extension);
      const voidIndexes = State.contours
        .map((contour, index) => contour._isVoid ? index : -1)
        .filter(index => index !== -1);
      const visibleVoidCount = voidIndexes.filter(index =>
        Utils.isVisibleContour(State.contours[index])
      ).length;
      const panelVoidCount = voidIndexes.filter(index =>
        Utils.isPanelContour(State.contours[index], index)
      ).length;
      PanelUI.selectAll();
      const selectedVoidCount = voidIndexes.filter(index =>
        State.selectedIdxs.has(index)
      ).length;
      PanelUI.selectNone();
      State.extrudeMode = 'separate';
      State.selectedIdxs.clear();
      State.contours.forEach((contour, index) => {
        if (!Utils.isVisibleContour(contour) || contour.depth % 2 === 1) return;
        contour.sel2D = true;
        State.selectedIdxs.add(index);
        State.selectedFaces.set(index, 'top');
      });
      document.getElementById('ex-depth').value = '3';
      document.getElementById('ex-bevel').value = '0';
      PanelUI.updateButtons();
      document.getElementById('btn-extrude').click();

      const invalidMeshes = State.pieces.filter(piece => {
        const positions = piece.mesh?.geometry?.attributes?.position;
        return !positions || positions.count < 3 ||
          !Number.isFinite(GeoModule.getPieceRealBox(piece).min.x);
      }).length;
      const generated = await Exporter.generate3MFBlob(State.pieces, name);
      const zip = await JSZip.loadAsync(generated.blob);
      const modelFile = Object.keys(zip.files).find(filename => /3dmodel\\.model$/i.test(filename));
      if (!modelFile) throw new Error(name + ': el 3MF no contiene el modelo.');
      const modelXml = await zip.file(modelFile).async('string');
      const model = inspect3MFModel(modelXml);
      const modelSettingsFile = zip.file('Metadata/model_settings.config');
      const projectSettingsFile = zip.file('Metadata/project_settings.config');
      const modelSettings = modelSettingsFile
        ? new DOMParser().parseFromString(
            await modelSettingsFile.async('string'),
            'application/xml'
          )
        : null;
      const projectSettings = projectSettingsFile
        ? JSON.parse(await projectSettingsFile.async('string'))
        : null;

      return {
        contourCount: shapeData.length,
        solidContourCount: shapeData.filter(item => item.depth % 2 === 0).length,
        oddDepthCount: shapeData.filter(item => item.depth % 2 === 1).length,
        voidCount: voidIndexes.length,
        syntheticVoidCount: shapeData.filter(item => item.syntheticVoid).length,
        visibleVoidCount,
        panelVoidCount,
        selectedVoidCount,
        voidPieceCount: State.pieces.filter(piece =>
          State.contours[piece.contourIdx]?._isVoid
        ).length,
        voidHoleCount: State.pieces.reduce(
          (count, piece) => count + (piece._holeIdxs || [])
            .filter(index => State.contours[index]?._isVoid).length,
          0
        ),
        coincidentBoundaryPairs,
        pieceCount: State.pieces.length,
        invalidMeshes,
        failedExports: generated.failedCount,
        blobBytes: generated.blob.size,
        metadataPartCount: modelSettings
          ? modelSettings.getElementsByTagName('part').length
          : 0,
        metadataExtruders: modelSettings
          ? [...modelSettings.querySelectorAll('part metadata[key="extruder"]')]
              .map(node => node.getAttribute('value'))
          : [],
        filamentColors: projectSettings?.filament_colour || [],
        filamentSettings: projectSettings?.filament_settings_id || [],
        filamentTypes: projectSettings?.filament_type || [],
        ...model,
      };
    }

    async function testBeveled3MFFlow() {
      await importThroughFileInput(dxfText, 'tucan-beveled.dxf');
      const contourIndex = State.contours.findIndex((contour, index) =>
        Utils.isVisibleContour(contour) &&
        contour.depth % 2 === 0 &&
        !State.contours.some(candidate =>
          candidate.parentIdx === index && candidate.depth % 2 === 1
        )
      );
      if (contourIndex < 0) throw new Error('No se encontro un contorno para probar bisel.');

      State.extrudeMode = 'separate';
      PanelUI.clearAllSelection();
      PanelUI.selectOne(contourIndex, true, undefined, 'top');
      document.getElementById('ex-depth').value = '3';
      document.getElementById('ex-bevel').value = '0.2';
      document.getElementById('ex-bseg').value = '3';
      PanelUI.updateButtons();
      document.getElementById('btn-extrude').click();

      const generated = await Exporter.generate3MFBlob(
        State.pieces,
        'tucan-beveled-test'
      );
      const zip = await JSZip.loadAsync(generated.blob);
      const modelXml = await zip.file('3D/3dmodel.model').async('string');
      const cleared = await Exporter.generate3MFBlob(
        State.pieces,
        'tucan-beveled-clearance-test',
        { clearanceMm: 0.001 }
      );
      const clearedZip = await JSZip.loadAsync(cleared.blob);
      const clearedXml = await clearedZip.file('3D/3dmodel.model').async('string');
      return {
        pieceCount: State.pieces.length,
        failedExports: generated.failedCount,
        clearance: {
          failedExports: cleared.failedCount,
          clearanceMm: cleared.clearanceMm,
          ...inspect3MFModel(clearedXml),
        },
        ...inspect3MFModel(modelXml),
      };
    }

    async function testMergedLayered3MFFlow() {
      await importThroughFileInput(dxfText, 'tucan-merged-layered.dxf');
      State.extrudeMode = 'merged';
      State.selectedIdxs.clear();
      State.selectedFaces.clear();
      State.contours.forEach((contour, index) => {
        if (!Utils.isVisibleContour(contour) || contour.depth % 2 === 1) return;
        contour.sel2D = true;
        State.selectedIdxs.add(index);
        State.selectedFaces.set(index, 'top');
      });
      document.getElementById('ex-depth').value = '1.5';
      document.getElementById('ex-bevel').value = '0';
      PanelUI.updateButtons();
      document.getElementById('btn-extrude').click();

      const basePiece = State.pieces[0];
      const sourceFaceIndexes = State.contours
        .map((contour, index) => ({ contour, index }))
        .filter(({ contour }) =>
          !contour._isFakeContour &&
          contour.piece === basePiece &&
          contour.depth % 2 === 0
        )
        .map(({ index }) => index);

      PanelUI.clearAllSelection();
      State.extrudeMode = 'separate';
      sourceFaceIndexes.forEach(index => {
        const contour = State.contours[index];
        contour.sel2D = true;
        State.selectedIdxs.add(index);
        State.selectedFaces.set(index, 'top');
      });
      document.getElementById('ex-depth').value = '1.5';
      PanelUI.updateButtons();
      document.getElementById('btn-extrude').click();

      const generated = await Exporter.generate3MFBlob(
        State.pieces,
        'tucan-merged-layered-test'
      );
      const zip = await JSZip.loadAsync(generated.blob);
      const modelXml = await zip.file('3D/3dmodel.model').async('string');
      const model = inspect3MFModel(modelXml);
      const modelSettingsText = await zip
        .file('Metadata/model_settings.config')
        .async('string');
      const modelSettings = new DOMParser().parseFromString(
        modelSettingsText,
        'application/xml'
      );
      const projectSettings = JSON.parse(
        await zip.file('Metadata/project_settings.config').async('string')
      );

      /* El fixture que va a Bambu Studio lleva el proyecto incrustado: es
         la unica forma de comprobar de verdad que esa parte extra no
         cambia como lee el laminador el 3MF. Si Bambu deja de laminarlo,
         el incrustado deja de ser gratis y hay que revisarlo. */
      const cleared = await Exporter.generate3MFBlob(
        State.pieces,
        'tucan-merged-layered-clearance-test',
        {
          clearanceMm: 0.001,
          embeddedProject: JSON.stringify(window.inkoraProject.buildPayload()),
        }
      );
      const clearedZip = await JSZip.loadAsync(cleared.blob);
      const clearedModelXml = await clearedZip.file('3D/3dmodel.model').async('string');
      const clearedModel = inspect3MFModel(clearedModelXml);

      // El fixture externo de Bambu usa la variante nueva; el 3MF normal ya
      // queda cubierto arriba por la inspeccion estructural completa.
      const bytes = new Uint8Array(await cleared.blob.arrayBuffer());
      let binary = '';
      for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
      }
      globalThis.__inkoraMerged3MFBase64 = btoa(binary);

      return {
        basePieceCount: 1,
        sourceFaceCount: sourceFaceIndexes.length,
        pieceCount: State.pieces.length,
        failedExports: generated.failedCount,
        blobBytes: generated.blob.size,
        metadataPartCount: modelSettings.getElementsByTagName('part').length,
        metadataExtruders: [...modelSettings.querySelectorAll('part metadata[key="extruder"]')]
          .map(node => node.getAttribute('value')),
        filamentColors: projectSettings.filament_colour || [],
        filamentSettings: projectSettings.filament_settings_id || [],
        filamentTypes: projectSettings.filament_type || [],
        clearance: {
          failedExports: cleared.failedCount,
          clearanceMm: cleared.clearanceMm,
          blobBytes: cleared.blob.size,
          ...clearedModel,
        },
        ...model,
      };
    }

    const sharedBoundary = resolveRectangles([0, 0, 10, 10], [5, 0, 15, 10]);
    const nearCoincident = resolveRectangles([0, 0, 10, 10], [0.005, 0, 10, 10]);
    const separateThinFeature = resolveRectangles([0, 0, 0.005, 10], [1, 0, 2, 10]);
    const metrics = {
      sharedBoundary: {
        ...sharedBoundary,
        gap: sharedBoundary.topBounds.minX - sharedBoundary.bottomBounds.maxX,
      },
      nearCoincident,
      separateThinFeature,
      materialVoids: await testMaterialVoidDetection(),
      dxf: summarize(await DXFParser.loadText(dxfText)),
      svg: summarize(await SVGParser.loadText(svgText)),
      modelImportRoundTrip: await testModelImportRoundTrip(dxfText, 'tucan-roundtrip', '.dxf'),
      objTucan: await testOBJExport(dxfText, 'tucan-obj', '.dxf'),
      objLayered: await testOBJExport(layeredSvgText, 'cataratas-obj', '.svg'),
      layeredDxf: await testLayeredArtwork(layeredDxfText, 'cataratas-dxf', '.dxf'),
      layeredSvg: await testLayeredArtwork(layeredSvgText, 'cataratas-svg', '.svg'),
      dxfFlow: await testFullFlow(DXFParser, dxfText, 'tucan-dxf-test'),
      svgFlow: await testFullFlow(SVGParser, svgText, 'tucan-svg-test'),
      beveled3MF: await testBeveled3MFFlow(),
      mergedLayered3MF: await testMergedLayered3MFFlow(),
      exportClearance: await testExportClearance(),
      viewportPanelSelection: await testViewportPanelSelectionSync(),
      undoRedo: await testUndoRedoExtrusion(),
      threeDFaceUndoRedoSeparate: await test3DFaceUndoRedo('separate'),
      threeDFaceUndoRedoMerged: await test3DFaceUndoRedo('merged'),
      visibilityUndoRedo: await testVisibilityUndoRedo(),
      additionalHistoryOperations: await testAdditionalHistoryOperations(),
      selectionSnapshot: await testSelectionSnapshot(),
      cameraImport: await testCameraImport(),
      adjacentGhostPicking: await testAdjacentGhostPicking(),
    };
    return metrics;
  })()`, true);
}

async function importVisualState(win, text, filename) {
  return win.webContents.executeJavaScript(`(async () => {
    const input = document.getElementById('file-input');
    const transfer = new DataTransfer();
    transfer.items.add(new File([${JSON.stringify(text)}], ${JSON.stringify(filename)}));
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    const expectedName = ${JSON.stringify(filename.replace(/\.(dxf|svg)$/i, ''))};
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (State.filename === expectedName && State.contours.length) {
        Viewport.focusAll();
        return { contours: State.contours.length };
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error(${JSON.stringify(filename)} + ': la vista 2D no terminó de importar.');
  })()`, true);
}

async function extrudeVisualState(win) {
  return win.webContents.executeJavaScript(`(() => {
    State.extrudeMode = 'separate';
    State.selectedIdxs.clear();
    State.contours.forEach((contour, index) => {
      if (!Utils.isVisibleContour(contour) || contour.depth % 2 === 1) return;
      contour.sel2D = true;
      State.selectedIdxs.add(index);
      State.selectedFaces.set(index, 'top');
    });
    document.getElementById('ex-depth').value = '3';
    document.getElementById('ex-bevel').value = '0';
    PanelUI.updateButtons();
    document.getElementById('btn-extrude').click();
    Viewport.focusAll();
    return { pieces: State.pieces.length };
  })()`, true);
}

async function captureVisuals(win) {
  const outputDir = path.join(app.getPath('temp'), 'inkora-geometry-tests');
  await fs.promises.mkdir(outputDir, { recursive: true });
  const captures = [];
  win.showInactive();
  await new Promise(resolve => setTimeout(resolve, 250));

  for (const model of [
    { text: dxfText, filename: 'tucan-visual.dxf', key: 'dxf' },
    { text: svgText, filename: 'tucan-visual.svg', key: 'svg' },
  ]) {
    await importVisualState(win, model.text, model.filename);
    await new Promise(resolve => setTimeout(resolve, 350));
    const twoDPath = path.join(outputDir, `tucan-${model.key}-2d.png`);
    await fs.promises.writeFile(twoDPath, (await win.capturePage()).toPNG());
    captures.push(twoDPath);

    await extrudeVisualState(win);
    await new Promise(resolve => setTimeout(resolve, 350));
    const threeDPath = path.join(outputDir, `tucan-${model.key}-3d.png`);
    await fs.promises.writeFile(threeDPath, (await win.capturePage()).toPNG());
    captures.push(threeDPath);
  }

  win.hide();
  return captures;
}

async function writeMerged3MFFixture(win) {
  const base64 = await win.webContents.executeJavaScript(
    'globalThis.__inkoraMerged3MFBase64 || ""'
  );
  if (!base64) throw new Error('No se genero el fixture 3MF unido.');
  const outputDir = path.join(app.getPath('temp'), 'inkora-geometry-tests');
  await fs.promises.mkdir(outputDir, { recursive: true });
  const fixturePath = path.join(outputDir, 'tucan-merged-layered-clearance.3mf');
  await fs.promises.writeFile(fixturePath, Buffer.from(base64, 'base64'));
  return fixturePath;
}

function inspectWithBambuStudio(fixturePath) {
  if (process.platform !== 'win32') return { available: false };
  const executable = 'C:\\Program Files\\Bambu Studio\\bambu-studio.exe';
  if (!fs.existsSync(executable)) return { available: false };

  const cwd = path.dirname(fixturePath);
  const infoResult = spawnSync(
    executable,
    ['--info', '--debug', '4', fixturePath],
    {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 120000,
      maxBuffer: 16 * 1024 * 1024,
    }
  );
  const output = `${infoResult.stdout || ''}\n${infoResult.stderr || ''}`;
  fs.writeFileSync(path.join(cwd, 'bambu-info.log'), output, 'utf8');
  if (infoResult.error) throw infoResult.error;
  if (infoResult.status !== 0) {
    throw new Error(`Bambu Studio --info termino con codigo ${infoResult.status}.`);
  }

  const values = pattern => [...output.matchAll(pattern)].map(match => Number(match[1]));
  const nonManifoldEdges = values(/non_manifold_edges\s*=\s*(\d+)/gi);
  const openEdges = values(/open_edges\s*=\s*(\d+)/gi);
  const assembled = output.match(/begin to assemble objects,\s*size\s*(\d+)/i);
  const sliceDir = path.join(cwd, `bambu-slice-${process.pid}-${Date.now()}`);
  fs.mkdirSync(sliceDir, { recursive: true });
  const sliceResult = spawnSync(
    executable,
    ['--slice', '0', '--debug', '4', '--outputdir', sliceDir, fixturePath],
    {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 120000,
      maxBuffer: 16 * 1024 * 1024,
    }
  );
  const sliceOutput = `${sliceResult.stdout || ''}\n${sliceResult.stderr || ''}`;
  fs.writeFileSync(path.join(sliceDir, 'bambu-slice.log'), sliceOutput, 'utf8');
  if (sliceResult.error) throw sliceResult.error;
  if (sliceResult.status !== 0) {
    throw new Error(`Bambu Studio --slice termino con codigo ${sliceResult.status}.`);
  }
  const resultPath = path.join(sliceDir, 'result.json');
  if (!fs.existsSync(resultPath)) {
    throw new Error('Bambu Studio no genero result.json al laminar.');
  }
  const sliceReport = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  const slicedPlate = sliceReport.sliced_plates?.[0];
  const gcodePath = path.join(sliceDir, 'plate_1.gcode');

  return {
    available: true,
    assembledObjectCount: assembled ? Number(assembled[1]) : null,
    nonManifoldEdges: nonManifoldEdges.reduce((sum, value) => sum + value, 0),
    openEdges: openEdges.reduce((sum, value) => sum + value, 0),
    manifoldFailures: (output.match(/manifold\s*=\s*no/gi) || []).length,
    treatedAsOtherVendor: /3mf from other vendor/i.test(output),
    sliceReturnCode: sliceReport.return_code,
    slicedObjectCount: slicedPlate?.objects?.length || 0,
    slicedTriangleCount: slicedPlate?.triangle_count || 0,
    sliceWarning: slicedPlate?.warning_message || '',
    gcodeBytes: fs.existsSync(gcodePath) ? fs.statSync(gcodePath).size : 0,
  };
}

function nearlyEqual(a, b, tolerance) {
  return Math.abs(a - b) <= tolerance;
}

function validate(metrics) {
  const failures = [];
  if (!nearlyEqual(metrics.sharedBoundary.gap, 0, 0.00011)) {
    failures.push(`el borde compartido pierde ${metrics.sharedBoundary.gap.toFixed(5)} mm`);
  }
  if (!nearlyEqual(metrics.sharedBoundary.totalArea, 150, 0.001)) {
    failures.push('el resolver elimina area fisica en el solape sintetico');
  }
  if (metrics.nearCoincident.count !== 1 || metrics.nearCoincident.bottomBounds !== null ||
      !nearlyEqual(metrics.nearCoincident.totalArea, 100, 0.001)) {
    failures.push('el residuo casi coincidente no se reasigna sin perder material');
  }
  if (metrics.separateThinFeature.count !== 2 || metrics.separateThinFeature.bottomBounds === null) {
    failures.push('una forma fina pero separada fue eliminada indebidamente');
  }
  const materialVoids = metrics.materialVoids;
  if (materialVoids.svgExplicit.voidCount !== 1 ||
      materialVoids.svgExplicit.syntheticVoidCount !== 0 ||
      materialVoids.svgExplicit.voidKinds[0] !== 'svg-material') {
    failures.push('SVG no reconoce un agujero explicito mediante su geometria de relleno');
  }
  if (materialVoids.svgFilled.voidCount !== 0) {
    failures.push('SVG conserva como hueco una region cubierta por material posterior');
  }
  if (materialVoids.svgComposite.voidCount !== 1 ||
      materialVoids.svgComposite.syntheticVoidCount !== 1) {
    failures.push('SVG no reconoce un hueco global formado por varias piezas');
  }
  if (materialVoids.dxfInferred.voidCount !== 1 ||
      materialVoids.dxfInferred.syntheticVoidCount !== 0 ||
      materialVoids.dxfInferred.voidKinds[0] !== 'dxf-inferred') {
    failures.push('DXF no infiere el agujero de un objeto compuesto de Corel');
  }
  if (materialVoids.dxfFilled.voidCount !== 0) {
    failures.push('DXF conserva como hueco una region cubierta por otra entidad');
  }
  if (materialVoids.dxfWhiteOnBlack.voidCount !== 0) {
    failures.push('DXF toma como hueco una pieza apoyada encima que comparte el ACI del fondo');
  }
  if (materialVoids.dxfSameSpecDonut.voidCount !== 1 ||
      materialVoids.dxfSameSpecDonut.voidKinds[0] !== 'dxf-inferred') {
    failures.push('DXF pierde el agujero de un compuesto cuyos anillos comparten especificacion de color');
  }
  if (metrics.svg.minArea < 1) {
    failures.push(`SVG conserva un residuo de solo ${metrics.svg.minArea.toFixed(6)} mm2`);
  }
  if (metrics.dxf.colorCount < 3) failures.push(`DXF conserva solo ${metrics.dxf.colorCount} colores`);
  if (metrics.svg.colorCount < 4) failures.push(`SVG conserva solo ${metrics.svg.colorCount} colores`);
  for (const key of ['objTucan', 'objLayered']) {
    const obj = metrics[key];
    if (obj.outOfRange) {
      failures.push(`${key}: ${obj.outOfRange} indice(s) de OBJ fuera de rango o no 1-based`);
    }
    if (obj.vertices !== obj.declaredVertices) {
      failures.push(`${key}: el OBJ escribe ${obj.vertices} vertices y declara ${obj.declaredVertices}`);
    }
    if (obj.groups !== obj.pieces) {
      failures.push(`${key}: ${obj.groups} grupos para ${obj.pieces} piezas`);
    }
    if (obj.openEdges || obj.overusedEdges || obj.degenerate) {
      failures.push(
        `${key}: OBJ con ${obj.openEdges} aristas abiertas, ${obj.overusedEdges} sobreusadas y ${obj.degenerate} triangulos degenerados`
      );
    }
    if (!obj.mtllibMatchesFilename) {
      failures.push(`${key}: mtllib no coincide con el nombre real del .mtl`);
    }
    if (obj.missingMaterials || obj.unusedMaterials) {
      failures.push(
        `${key}: ${obj.missingMaterials} material(es) usados sin declarar y ${obj.unusedMaterials} declarados sin usar`
      );
    }
    if (!obj.colorParityWith3MF) {
      failures.push(`${key}: OBJ y 3MF no coinciden en cantidad de colores`);
    }
  }
  for (const format of ['Dxf', 'Svg']) {
    const layered = metrics[`layered${format}`];
    const label = format.toUpperCase();
    if (layered.voids !== 1) {
      failures.push(`${label} por capas: ${layered.voids} vacios en vez del unico hueco real`);
    }
    if (layered.selectable !== layered.contours - layered.voids) {
      failures.push(
        `${label} por capas: solo ${layered.selectable} de ${layered.contours - layered.voids} contornos con material son seleccionables`
      );
    }
    if (layered.colors < 4) {
      failures.push(`${label} por capas: conserva solo ${layered.colors} colores`);
    }
    for (const [mode, run] of Object.entries(layered.modes)) {
      if (!run.pieces) {
        failures.push(`${label} por capas (${mode}): seleccionar todo y extruir no produjo piezas`);
      }
      if (run.invalidMeshes) {
        failures.push(`${label} por capas (${mode}): ${run.invalidMeshes} mallas invalidas`);
      }
      if (mode === 'merged' &&
          (run.failedExports || run.nonManifoldEdges ||
           run.inconsistentWindingEdges || run.nonPositiveVolumes)) {
        failures.push(
          `${label} por capas (${mode}): 3MF con ${run.failedExports} exportaciones fallidas, ${run.nonManifoldEdges} aristas no manifold, ${run.inconsistentWindingEdges} de winding y ${run.nonPositiveVolumes} volumenes no positivos`
        );
      }
      // Presupuesto amplio a proposito: mide que la union sea sub-cuadratica,
      // no la velocidad exacta de la maquina. Antes de la union por pares
      // este mismo modelo tardaba mas de 80 s o abortaba.
      if (run.elapsedMs > 15000) {
        failures.push(`${label} por capas (${mode}): la extrusion tardo ${run.elapsedMs} ms`);
      }
    }
    if (layered.modes.merged.pieces !== 1) {
      failures.push(`${label} por capas: el modo unido produjo ${layered.modes.merged.pieces} piezas`);
    }
  }
  for (const format of ['dxf', 'svg']) {
    const flow = metrics[`${format}Flow`];
    const parsed = metrics[format];
    if (parsed.voidCount !== 1 || parsed.syntheticVoidCount !== 0 ||
        flow.voidCount !== 1 || flow.syntheticVoidCount !== 0) {
      failures.push(`${format.toUpperCase()}: el agujero real del Tucan no se identifica una sola vez`);
    }
    if (flow.visibleVoidCount !== 0 || flow.panelVoidCount !== 0 ||
        flow.selectedVoidCount !== 0 || flow.voidPieceCount !== 0) {
      failures.push(`${format.toUpperCase()}: un vacio real aparece o se comporta como pieza seleccionable`);
    }
    if (flow.voidHoleCount !== 1) {
      failures.push(`${format.toUpperCase()}: el vacio real no se incorporo a la extrusion como agujero`);
    }
    if (flow.coincidentBoundaryPairs < 1) failures.push(`${format.toUpperCase()}: no conserva fronteras compartidas exactas`);
    if (flow.pieceCount !== flow.solidContourCount) failures.push(`${format.toUpperCase()}: se extruyeron ${flow.pieceCount} de ${flow.solidContourCount} piezas sólidas`);
    if (flow.invalidMeshes) failures.push(`${format.toUpperCase()}: ${flow.invalidMeshes} mallas inválidas`);
    if (flow.failedExports) failures.push(`${format.toUpperCase()}: ${flow.failedExports} piezas fallaron al exportar`);
    if (flow.objectCount !== flow.pieceCount) failures.push(`${format.toUpperCase()}: el 3MF contiene ${flow.objectCount} objetos para ${flow.pieceCount} piezas`);
    if (flow.componentObjectCount !== 1 ||
        flow.rootComponentCount !== flow.pieceCount ||
        flow.buildItemCount !== 1) {
      failures.push(`${format.toUpperCase()}: el 3MF no contiene una unica raiz multipartes`);
    }
    if (flow.metadataPartCount !== flow.pieceCount ||
        flow.metadataExtruders.length !== flow.pieceCount ||
        flow.metadataExtruders.some(value =>
          Number(value) < 1 || Number(value) > flow.colorCount
        )) {
      failures.push(`${format.toUpperCase()}: faltan asignaciones de extrusor por volumen`);
    }
    if (flow.filamentColors.length !== flow.colorCount ||
        flow.filamentSettings.length !== flow.colorCount ||
        flow.filamentTypes.length !== flow.colorCount) {
      failures.push(`${format.toUpperCase()}: la paleta de Bambu no coincide con los materiales 3MF`);
    }
    if (!flow.triangleCount) failures.push(`${format.toUpperCase()}: el 3MF no contiene triángulos`);
    if (flow.nonManifoldEdges) failures.push(`${format.toUpperCase()}: el 3MF contiene ${flow.nonManifoldEdges} aristas no manifold`);
    if (flow.inconsistentWindingEdges) {
      failures.push(`${format.toUpperCase()}: el 3MF contiene ${flow.inconsistentWindingEdges} aristas con winding inconsistente`);
    }
    if (flow.nonPositiveVolumes) {
      failures.push(`${format.toUpperCase()}: el 3MF contiene ${flow.nonPositiveVolumes} volumenes no positivos`);
    }
  }
  /* Reimportacion. El contrato tiene dos mitades y las dos importan:
     el proyecto incrustado devuelve el original exacto, y la
     reconstruccion desde malla devuelve las mismas piezas, colores y
     medidas. Una tolerancia de 0,01 mm cubre la cuantizacion de la
     grilla de Clipper (1e-4 mm) sin dejar pasar una silueta distinta. */
  const trip = metrics.modelImportRoundTrip;
  if (!trip.embedded3MFPartPresent ||
      trip.embedded3MFProjectContours !== trip.originalContours ||
      trip.embedded3MFProjectPieces !== trip.originalPieces) {
    failures.push('el 3MF no conserva el proyecto incrustado completo');
  }
  if (trip.objEmbeddedProjectContours !== trip.originalContours) {
    failures.push('el OBJ no conserva el proyecto incrustado completo');
  }
  if (trip.plain3MFHasProject) {
    failures.push('un 3MF exportado sin proyecto trae uno igual');
  }
  if (trip.plain3MFMeshCount !== trip.originalPieces ||
      trip.objPlainMeshCount !== trip.originalPieces ||
      trip.objRebuiltPieces !== trip.originalPieces) {
    failures.push('la lectura de malla no recupera una pieza por volumen exportado');
  }
  if (trip.restoredPieces !== trip.originalPieces ||
      trip.restoredColors.join(',') !== trip.originalColors.join(',') ||
      trip.restoredSize.some((value, i) => Math.abs(value - trip.originalSize[i]) > 1e-4)) {
    failures.push(
      'restaurar el proyecto incrustado no devuelve el modelo original ' +
      `(${trip.restoredPieces}/${trip.originalPieces} piezas)`
    );
  }
  if (trip.rebuiltSkipped ||
      trip.rebuiltPieces !== trip.originalPieces ||
      trip.rebuiltColors.join(',') !== trip.originalColors.join(',')) {
    failures.push('la reconstruccion desde malla pierde piezas o colores');
  }
  if (trip.rebuiltSize.some((value, i) => Math.abs(value - trip.originalSize[i]) > 0.01)) {
    failures.push(
      'la reconstruccion desde malla no conserva las medidas: ' +
      `${JSON.stringify(trip.originalSize)} -> ${JSON.stringify(trip.rebuiltSize)}`
    );
  }

  const beveled = metrics.beveled3MF;
  if (beveled.pieceCount !== 1 ||
      beveled.failedExports ||
      beveled.objectCount !== 1 ||
      beveled.componentObjectCount !== 1 ||
      beveled.rootComponentCount !== 1 ||
      beveled.buildItemCount !== 1 ||
      beveled.nonManifoldEdges ||
      beveled.inconsistentWindingEdges ||
      beveled.nonPositiveVolumes) {
    failures.push('una pieza biselada no conserva una malla 3MF manifold');
  }
  if (beveled.clearance.failedExports ||
      beveled.clearance.clearanceMm !== 0.001 ||
      beveled.clearance.objectCount !== 1 ||
      beveled.clearance.nonManifoldEdges ||
      beveled.clearance.inconsistentWindingEdges ||
      beveled.clearance.nonPositiveVolumes) {
    failures.push('la separacion de exportacion rompe una pieza biselada');
  }
  const merged = metrics.mergedLayered3MF;
  if (merged.basePieceCount !== 1 || merged.pieceCount !== merged.sourceFaceCount + 1) {
    failures.push('el flujo unido y re-extruido no conserva la cantidad esperada de volumenes');
  }
  if (merged.failedExports ||
      merged.objectCount !== merged.pieceCount ||
      merged.componentObjectCount !== 1 ||
      merged.rootComponentCount !== merged.pieceCount ||
      merged.buildItemCount !== 1 ||
      merged.metadataPartCount !== merged.pieceCount ||
      merged.metadataExtruders.length !== merged.pieceCount ||
      merged.metadataExtruders.some(value =>
        Number(value) < 1 || Number(value) > merged.colorCount
      )) {
    failures.push('el tucan unido y por capas no se exporta como un unico modelo multipartes');
  }
  if (merged.colorCount !== 3 ||
      merged.filamentColors.length !== 3 ||
      merged.filamentSettings.length !== 3 ||
      merged.filamentTypes.length !== 3) {
    failures.push('el tucan unido no conserva sus tres materiales');
  }
  if (merged.nonManifoldEdges ||
      merged.inconsistentWindingEdges ||
      merged.nonPositiveVolumes) {
    failures.push(
      `el tucan unido exporta topologia invalida ` +
      `(non-manifold ${merged.nonManifoldEdges}, winding ${merged.inconsistentWindingEdges}, ` +
      `volumen ${merged.nonPositiveVolumes})`
    );
  }
  if (merged.clearance.failedExports ||
      merged.clearance.clearanceMm !== 0.001 ||
      merged.clearance.objectCount !== merged.pieceCount ||
      merged.clearance.componentObjectCount !== 1 ||
      merged.clearance.rootComponentCount !== merged.pieceCount ||
      merged.clearance.buildItemCount !== 1 ||
      merged.clearance.nonManifoldEdges ||
      merged.clearance.inconsistentWindingEdges ||
      merged.clearance.nonPositiveVolumes) {
    failures.push('el Tucan con separacion no conserva su estructura multipartes manifold');
  }
  const clearance = metrics.exportClearance;
  if (clearance.toggleInitial !== 'false' ||
      clearance.toggleEnabled !== 'true' ||
      clearance.toggleRestored !== 'false') {
    failures.push('el control de separacion 3MF no alterna su estado correctamente');
  }
  if (clearance.inputInitial !== '0,001' ||
      clearance.inputRestored !== '0,001' ||
      clearance.inputValid !== 'false' ||
      clearance.customUiClearance !== 0.0025) {
    failures.push('el valor editable de separacion 3MF no llega correctamente al exportador');
  }
  if (clearance.optionOff !== 0 ||
      !nearlyEqual(clearance.plainSideGap, 0, 0.000001) ||
      !nearlyEqual(clearance.plainVerticalGap, 0, 0.000001)) {
    failures.push('desactivar la separacion altera la geometria exportada actual');
  }
  if (clearance.optionOn !== 0.001 ||
      !nearlyEqual(clearance.clearedSideGap, 0.001, 0.000002) ||
      !nearlyEqual(clearance.clearedVerticalGap, 0.001, 0.000002)) {
    failures.push(
      `la separacion exportada no mide 0,001 mm ` +
      `(lateral ${clearance.clearedSideGap}, vertical ${clearance.clearedVerticalGap})`
    );
  }
  if (!clearance.modelUnchanged) {
    failures.push('la separacion de exportacion modifica las piezas del proyecto');
  }
  if (clearance.clearedTopology.nonManifoldEdges ||
      clearance.clearedTopology.inconsistentWindingEdges ||
      clearance.clearedTopology.nonPositiveVolumes) {
    failures.push('la separacion exportada produce topologia invalida');
  }
  const panelSelection = metrics.viewportPanelSelection;
  if (panelSelection.selected.length !== 1 ||
      !panelSelection.selectedIsHiddenSubface ||
      !panelSelection.samePiece ||
      !panelSelection.rowSelected ||
      !panelSelection.groupExpanded) {
    failures.push(
      'seleccionar una subcara desde el viewport no sincroniza y revela su fila visible'
    );
  }
  const history = metrics.undoRedo;
  if (JSON.stringify(history.initialFlat) !== JSON.stringify(history.afterUndoFlat)) {
    failures.push('UNDO reconstruye objetivos 2D distintos a los importados');
  }
  if (JSON.stringify(history.initialVoids) !== JSON.stringify(history.afterUndoVoids)) {
    failures.push('UNDO pierde o modifica la clasificacion de vacios reales');
  }
  if (!history.afterUndoSelectionCoherent) {
    failures.push('UNDO deja sel2D, selectedIdxs o selectedFaces en desacuerdo');
  }
  if (history.secondPick.length !== 1 || history.secondPick[0] !== history.firstPick) {
    failures.push(`el click junto al contorno cambia de ${history.firstPick} a ${history.secondPick.join(',')} después de UNDO`);
  }
  if (!history.firstExtrusion ||
      JSON.stringify(history.firstExtrusion) !== JSON.stringify(history.secondExtrusion)) {
    failures.push('la segunda extrusión después de UNDO no coincide con la primera');
  }
  if (JSON.stringify(history.firstExtrusion) !== JSON.stringify(history.redoneExtrusion)) {
    failures.push('REDO no reconstruye exactamente la extrusión original');
  }
  if (!history.redoDiscardedAfterNewExtrusion) {
    failures.push('una extrusión nueva después de UNDO no descarta la rama de REDO');
  }
  for (const key of ['threeDFaceUndoRedoSeparate', 'threeDFaceUndoRedoMerged']) {
    const faceHistory = metrics[key];
    const expectedPick = JSON.stringify([faceHistory.parentIdx]);
    if (JSON.stringify(faceHistory.firstPick) !== expectedPick ||
        JSON.stringify(faceHistory.secondPick) !== expectedPick) {
      failures.push(
        `${faceHistory.mode}: el picking de cara 3D junto al borde cambia durante UNDO`
      );
    }
    if (!faceHistory.firstLayer ||
        JSON.stringify(faceHistory.firstLayer) !== JSON.stringify(faceHistory.secondLayer) ||
        JSON.stringify(faceHistory.firstLayer) !== JSON.stringify(faceHistory.redoneLayer)) {
      failures.push(
        `${faceHistory.mode}: la re-extrusión 3D no sobrevive igual a UNDO/REDO`
      );
    }
    if (!faceHistory.coherent) {
      failures.push(`${faceHistory.mode}: la selección 3D queda incoherente después de REDO`);
    }
  }
  const visibility = metrics.visibilityUndoRedo;
  if (!visibility.hiddenAfterAction || !visibility.visibleAfterUndo ||
      !visibility.hiddenAfterRedo || !visibility.isolatedAfterAction ||
      !visibility.allVisibleAfterUndo || !visibility.isolatedAfterRedo ||
      !visibility.coherent) {
    failures.push('ocultar/aislar no conserva estado y selección durante UNDO/REDO');
  }
  const additional = metrics.additionalHistoryOperations;
  if (!additional.duplicateAfterAction ||
      JSON.stringify(additional.duplicateAfterAction) !== JSON.stringify(additional.duplicateAfterRedo) ||
      additional.countAfterDuplicate !== 3 ||
      additional.countAfterDuplicateUndo !== 2) {
    failures.push('duplicar una re-extrusión compleja no sobrevive a UNDO/REDO');
  }
  if (additional.countAfterDelete !== 2 ||
      additional.countAfterDeleteUndo !== 3 ||
      additional.countAfterDeleteRedo !== 2) {
    failures.push('borrar una pieza no conserva la cantidad correcta durante UNDO/REDO');
  }
  if (JSON.stringify(additional.colorsBefore) !== JSON.stringify(additional.colorsAfterUndo) ||
      !additional.colorsAfterAction.every(color => color === '#2468ac') ||
      JSON.stringify(additional.colorsAfterAction) !== JSON.stringify(additional.colorsAfterRedo)) {
    failures.push('el color de selección no sobrevive correctamente a UNDO/REDO');
  }
  if (additional.groupsAfterAction !== 1 ||
      additional.groupsAfterUndo !== 0 ||
      additional.groupsAfterRedo !== 1 ||
      !additional.coherent) {
    failures.push('agrupar no conserva grupo y selección durante UNDO/REDO');
  }
  const selection = metrics.selectionSnapshot;
  if (JSON.stringify(selection.expected) !== JSON.stringify(selection.restored) ||
      selection.faces.length !== selection.expected.length ||
      !selection.coherent) {
    failures.push('UNDO no restaura una selección unificada coherente');
  }
  if (metrics.cameraImport.immediateDelta > 1e-8 ||
      metrics.cameraImport.settledDelta > 1e-8) {
    failures.push(
      `importar modifica la cámara (inmediato ${metrics.cameraImport.immediateDelta}, final ${metrics.cameraImport.settledDelta})`
    );
  }
  const ghostPick = metrics.adjacentGhostPicking;
  if (ghostPick.pickBeforeExtrude.length !== 1 || ghostPick.pickBeforeExtrude[0] !== ghostPick.realIdx) {
    failures.push(
      `Camem: clickear el contorno real (idx ${ghostPick.realIdx}) resuelve a ${JSON.stringify(ghostPick.pickBeforeExtrude)} en vez de al contorno real -- el fantasma de frontera coincidente (idx ${ghostPick.ghostIdx}) le gana el click`
    );
  }
  if (!ghostPick.realExtruded || ghostPick.piecesCreated !== 1 || ghostPick.realPieceColor !== ghostPick.designColor) {
    failures.push(
      `Camem: extruir el contorno real (idx ${ghostPick.realIdx}) no produjo la pieza esperada (color ${ghostPick.realPieceColor} contra ${ghostPick.designColor} esperado)`
    );
  }
  if (!ghostPick.ghostUntouched) {
    failures.push(`Camem: extruir el contorno real también extruyó su fantasma (idx ${ghostPick.ghostIdx})`);
  }
  if (failures.length) throw new Error(failures.join('\n'));
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 1600,
    height: 900,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  const pageErrors = [];
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2 && !message.includes('Electron Security Warning')) pageErrors.push(message);
  });

  try {
    await win.loadFile(htmlPath);
    await waitForGeometryRuntime(win);
    const metrics = await collectMetrics(win);
    console.log(JSON.stringify(metrics, null, 2));
    if (pageErrors.length) {
      throw new Error(`Errores de consola:\n${pageErrors.join('\n')}`);
    }
    validate(metrics);
    const mergedFixture = await writeMerged3MFFixture(win);
    const bambu = inspectWithBambuStudio(mergedFixture);
    console.log(`Bambu Studio inspection:\n${JSON.stringify(bambu, null, 2)}`);
    if (bambu.available &&
        (bambu.assembledObjectCount !== 1 ||
         bambu.nonManifoldEdges !== 0 ||
         bambu.openEdges !== 0 ||
         bambu.manifoldFailures !== 0 ||
         bambu.sliceReturnCode !== 0 ||
         bambu.slicedObjectCount !== 1 ||
         bambu.slicedTriangleCount !== metrics.mergedLayered3MF.clearance.triangleCount ||
         bambu.gcodeBytes === 0)) {
      throw new Error(
        `Bambu Studio rechazo o lamino mal el fixture:\n${JSON.stringify(bambu, null, 2)}`
      );
    }
    const captures = await captureVisuals(win);
    console.log(`Visual captures:\n${captures.join('\n')}`);
    console.log('Geometry regression: OK');
    app.exit(0);
  } catch (err) {
    if (pageErrors.length) console.error(`Renderer errors:\n${pageErrors.join('\n')}`);
    console.error(err.stack || err);
    app.exit(1);
  }
});
