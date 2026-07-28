const electronApi = require('electron');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

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
const htmlPath = path.join(repoRoot, 'inkora-3d-modeler-v10-corregido.html');
const dxfText = fs.readFileSync(path.join(repoRoot, 'Modelos', 'Tucan.dxf'), 'latin1');
const svgText = fs.readFileSync(path.join(repoRoot, 'Modelos', 'Tucan.svg'), 'utf8');

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
        colorCount: new Set(items.map(item => item.color).filter(Boolean)).size,
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

      objects.forEach(object => {
        const edgeCounts = new Map();
        const vertices = [...object.getElementsByTagName('vertex')].map(vertex =>
          ['x', 'y', 'z'].map(axis => Number(vertex.getAttribute(axis)).toFixed(6)).join(',')
        );
        const triangles = [...object.getElementsByTagName('triangle')];
        triangleCount += triangles.length;
        triangles.forEach(triangle => {
          const refs = [1, 2, 3].map(i => Number(triangle.getAttribute('v' + i)));
          [[0, 1], [1, 2], [2, 0]].forEach(([a, b]) => {
            const pointA = vertices[refs[a]];
            const pointB = vertices[refs[b]];
            const edge = pointA < pointB
              ? pointA + ':' + pointB
              : pointB + ':' + pointA;
            edgeCounts.set(edge, (edgeCounts.get(edge) || 0) + 1);
          });
        });
        nonManifoldEdges += [...edgeCounts.values()].filter(count => count !== 2).length;
      });

      return { objectCount: objects.length, triangleCount, nonManifoldEdges };
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
      const nearBoundary = findNearBoundaryFacePick();
      if (!nearBoundary) throw new Error('No se encontró una cara seleccionable cerca de un contorno.');

      document.getElementById('ex-depth').value = '3';
      document.getElementById('ex-bevel').value = '0';
      document.getElementById('btn-extrude').click();
      const firstExtrusion = extrusionSignature(nearBoundary.parentIdx);

      document.getElementById('btn-undo').click();
      const afterUndoFlat = flatSignatures();
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
      document.dispatchEvent(new KeyboardEvent('keydown', {
        bubbles: true, key: 'g', ctrlKey: true,
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

    async function testFullFlow(parser, text, name) {
      const shapeData = await parser.loadText(text);
      const coincidentBoundaryPairs = countCoincidentBounds(shapeData);
      const extension = parser === SVGParser ? '.svg' : '.dxf';
      await importThroughFileInput(text, name + extension);
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

      return {
        contourCount: shapeData.length,
        solidContourCount: shapeData.filter(item => item.depth % 2 === 0).length,
        oddDepthCount: shapeData.filter(item => item.depth % 2 === 1).length,
        coincidentBoundaryPairs,
        pieceCount: State.pieces.length,
        invalidMeshes,
        failedExports: generated.failedCount,
        blobBytes: generated.blob.size,
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
      dxf: summarize(await DXFParser.loadText(dxfText)),
      svg: summarize(await SVGParser.loadText(svgText)),
      dxfFlow: await testFullFlow(DXFParser, dxfText, 'tucan-dxf-test'),
      svgFlow: await testFullFlow(SVGParser, svgText, 'tucan-svg-test'),
      undoRedo: await testUndoRedoExtrusion(),
      threeDFaceUndoRedoSeparate: await test3DFaceUndoRedo('separate'),
      threeDFaceUndoRedoMerged: await test3DFaceUndoRedo('merged'),
      visibilityUndoRedo: await testVisibilityUndoRedo(),
      additionalHistoryOperations: await testAdditionalHistoryOperations(),
      selectionSnapshot: await testSelectionSnapshot(),
      cameraImport: await testCameraImport(),
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
  if (metrics.svg.minArea < 1) {
    failures.push(`SVG conserva un residuo de solo ${metrics.svg.minArea.toFixed(6)} mm2`);
  }
  if (metrics.dxf.colorCount < 3) failures.push(`DXF conserva solo ${metrics.dxf.colorCount} colores`);
  if (metrics.svg.colorCount < 4) failures.push(`SVG conserva solo ${metrics.svg.colorCount} colores`);
  for (const format of ['dxf', 'svg']) {
    const flow = metrics[`${format}Flow`];
    if (flow.coincidentBoundaryPairs < 1) failures.push(`${format.toUpperCase()}: no conserva fronteras compartidas exactas`);
    if (flow.pieceCount !== flow.solidContourCount) failures.push(`${format.toUpperCase()}: se extruyeron ${flow.pieceCount} de ${flow.solidContourCount} piezas sólidas`);
    if (flow.invalidMeshes) failures.push(`${format.toUpperCase()}: ${flow.invalidMeshes} mallas inválidas`);
    if (flow.failedExports) failures.push(`${format.toUpperCase()}: ${flow.failedExports} piezas fallaron al exportar`);
    if (flow.objectCount !== flow.pieceCount) failures.push(`${format.toUpperCase()}: el 3MF contiene ${flow.objectCount} objetos para ${flow.pieceCount} piezas`);
    if (!flow.triangleCount) failures.push(`${format.toUpperCase()}: el 3MF no contiene triángulos`);
    if (flow.nonManifoldEdges) failures.push(`${format.toUpperCase()}: el 3MF contiene ${flow.nonManifoldEdges} aristas no manifold`);
  }
  const history = metrics.undoRedo;
  if (JSON.stringify(history.initialFlat) !== JSON.stringify(history.afterUndoFlat)) {
    failures.push('UNDO reconstruye objetivos 2D distintos a los importados');
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
    const captures = await captureVisuals(win);
    console.log(`Visual captures:\n${captures.join('\n')}`);
    console.log('Geometry regression: OK');
    app.exit(0);
  } catch (err) {
    console.error(err.stack || err);
    app.exit(1);
  }
});
