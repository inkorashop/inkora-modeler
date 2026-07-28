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

      const cleared = await Exporter.generate3MFBlob(
        State.pieces,
        'tucan-merged-layered-clearance-test',
        { clearanceMm: 0.001 }
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
      dxf: summarize(await DXFParser.loadText(dxfText)),
      svg: summarize(await SVGParser.loadText(svgText)),
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
