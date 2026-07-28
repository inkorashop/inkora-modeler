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
