# Decisiones técnicas — INKORA 3D Modeler

Este archivo documenta decisiones de arquitectura y bugs de raíz corregidos,
para que no se reintroduzcan por accidente en trabajo futuro (humano o IA).

## 2026-07 — Re-extrusión anclaba con un hueco real (~0.05mm) → piezas "flotantes" al exportar/imprimir

### Síntoma

Al extruir un diseño completo como "Objeto unido" y luego volver a extruir
(re-extruir) una cara de una parte ya extruida, la pieza nueva quedaba
separada de la anterior por un hueco microscópico (décimas de mm). No se
notaba a simple vista en el visor, pero el laminador detectaba la pieza
re-extruida como flotante (no unida al resto) al preparar la impresión.

### Causa raíz

`anchorYForFace()` (la función que decide a qué altura Y "engancha" una
re-extrusión) calculaba la altura de la cara superior/inferior con:

```js
const box = new THREE.Box3().setFromObject(piece.mesh);
```

`Box3.setFromObject` recorre **todos los hijos** del mesh, y una pieza
extruida acumula dos tipos de geometría hija puramente decorativa/de
interacción, ninguna parte de la geometría sólida real:

1. Las líneas de contorno negras (`mesh.add(line)` en `GeoModule.extrude()`,
   función `addShapeOutline`) — dibujadas ligeramente por fuera de la cara
   real (antes 0.05mm) para no parpadear contra la superficie sólida en el
   render (anti z-fighting visual).
2. En piezas creadas con "Objeto unido", además, las mallas y líneas de
   "picking" por contorno (`addMergedContourPickLines`, función interna
   `addArea`/`addLine`) que permiten click-seleccionar un sub-contorno
   dentro de la pieza fusionada — con offsets de **hasta 0.16mm**.

Ambas se suman en la misma caja. Confirmado con un test numérico (ver
"Verificación" más abajo): en una pieza fusionada, `Box3.setFromObject`
daba una caja **0.165mm más alta** que la geometría sólida real — no los
0.05mm que parecían al leer solo `addShapeOutline` en aislamiento. Esto
explica que el desfase percibido en el llavero Akrapovic fuera mayor a lo
que un solo mecanismo (el contorno) explicaría por sí solo.

Esto **solo afectaba a la re-extrusión** (extruir sobre una cara de una pieza
ya 3D). La primera extrusión (contorno 2D → 3D) posiciona el mesh por fórmula
directa y no pasa por esta función.

### Esto ya estaba resuelto una vez en el proyecto — la inconsistencia era el bug

`PanelUI` ya tenía una función privada, `getPieceRealBox(piece)`, con
**exactamente el mismo fix** (medir solo `mesh.geometry` + `matrixWorld`),
usada por `selectModelExtremeFace` (Ctrl+1/Ctrl+2) — con un comentario propio
que ya advertía: *"a diferencia de `Box3.setFromObject(mesh)`... ignora las
líneas de contorno hijas (que sobresalen ±0.05..0.16 más allá de la cara
real)"*. O sea: el patrón correcto ya existía en el código, solo que
`anchorYForFace` no lo usaba. El bug real no era desconocer la solución —
era tener **dos caminos para lo mismo, uno correcto y otro no**.

### Por qué no se corrigió "restando 0.05 a mano"

Sería un parche: funciona hoy, se rompe apenas cambie ese valor decorativo o
se agregue otro hijo al mesh en el futuro. No corrige el problema real, que
es **mezclar geometría de render (decorativa) con geometría real** en el
mismo cálculo.

### Solución aplicada

`getPieceRealBox(piece)` es ahora la **única** implementación (antes había
una copia en `PanelUI` y la lógica repetida — mal — en `anchorYForFace`),
movida a `GeoModule` y expuesta públicamente. Mide **solo**
`piece.mesh.geometry` (la `ExtrudeGeometry` real, sin recorrer hijos) y
aplica `mesh.matrixWorld` para llevarlo a espacio mundial — lo cual respeta
automáticamente cualquier traslación, rotación en Y o escala que tenga la
pieza (`TransformModule`), sin necesidad de recalcular esa lógica a mano.

```js
function getPieceRealBox(piece) {
  const box = new THREE.Box3();
  if (!piece?.mesh?.geometry?.attributes?.position) return box;
  piece.mesh.updateMatrixWorld(true);
  box.setFromBufferAttribute(piece.mesh.geometry.attributes.position);
  box.applyMatrix4(piece.mesh.matrixWorld);
  return box;
}

function anchorYForFace(piece, face) {
  const box = getPieceRealBox(piece);
  return face === 'bottom' ? box.min.y : box.max.y;
}
```

`selectModelExtremeFace` (en `PanelUI`) ahora llama a
`GeoModule.getPieceRealBox` en vez de su copia local — una sola fuente de
verdad para "medir la geometría sólida real de una pieza", usada tanto para
anclar re-extrusiones como para encontrar la cara más extrema del modelo.

`anchorYForFace` y `directedDepthForFace` (antes anidadas dentro del handler
del botón "Extruir", no reusables) también se movieron a `GeoModule`, junto
con `extrude`/`makePiece` — es donde corresponde vivir lógica de geometría
de piezas, no dentro de un event handler de UI.

### Regla de arquitectura que queda establecida

**Nunca derivar una posición/medida real de un `Box3.setFromObject()` sobre
un `Object3D` que pueda tener hijos decorativos.** Si se necesita medir la
geometría real de una pieza, usar `GeoModule.getPieceRealBox(piece)` (mide
`mesh.geometry` directamente + `matrixWorld`) — nunca confiar en que el
árbol de objetos de render solo contiene geometría "real": una pieza puede
tener líneas de contorno, mallas/líneas de picking, o futuros hijos
decorativos que no se conocen de antemano. El módulo `Exporter` ya seguía
un principio equivalente (reconstruye cada pieza desde sus datos fuente
para el 3MF, no desde la geometría de Three.js) — ahora todo el proyecto
usa una sola función para esto.

### El offset visual del contorno: se redujo, no se eliminó

Se bajó `capZs = [absDepth + 0.05, -0.05]` a `[absDepth + 0.005, -0.005]`
en `addShapeOutline` (`GeoModule.extrude`) — diez veces menos separación
visual entre el contorno decorativo y la cara real, buscando que deje de
"verse duplicado" sin arriesgar parpadeo (z-fighting).

**Se decidió no llevarlo a 0** porque, revisando cómo funciona
`polygonOffset` en WebGL: ese estado (`POLYGON_OFFSET_FILL`) solo afecta el
rasterizado de **triángulos**, no de líneas (`THREE.Line`/`LineBasicMaterial`)
— WebGL no expone `POLYGON_OFFSET_LINE`. Es probable que el `polygonOffset`
configurado en `outlineMat` no tenga ningún efecto real sobre esas líneas,
y que el offset geométrico sea, en la práctica, el único mecanismo que
evita que el contorno parpadee contra la cara sólida en el visor. Un valor
pequeño pero distinto de cero es el punto medio razonable; si en algún
momento se nota parpadeo o separación visual, ajustar este único número
(no hace falta ni conviene volver a tocar la arquitectura).

**Importante:** este valor es puramente visual — desde el fix de arriba,
`getPieceRealBox` lo ignora por completo, así que cambiarlo (subirlo,
bajarlo, o llevarlo a 0) **no puede volver a introducir el bug de impresión**.
Es un ajuste estético, no estructural.

### Verificación

Confirmado con Playwright (inyectando dos contornos rectangulares de
prueba, fusionándolos en "Objeto unido", extruyendo, y re-extruyendo la
cara superior — el mismo flujo que el llavero Akrapovic):

| Medición | Antes del fix | Después del fix |
|---|---|---|
| Gap real entre pieza base y re-extrusión (geometría sólida) | — | **0.000000mm** |
| Gap si se mide con `Box3.setFromObject` (método viejo, incluye hijos decorativos) | ~0.165mm | (ya no se usa en ningún lado) |

Sin errores de consola. Sintaxis del archivo completo validada con
`node --check`.

## Seguimiento (mismo día) — el contorno seguía viéndose duplicado en piezas fusionadas

Después del fix de arriba, el gap de impresión ya estaba resuelto, pero
visualmente el contorno de una pieza "Objeto unido" seguía viéndose como
dos líneas: una pegada (bien) y otra idéntica flotando.

### Causa: dos mecanismos distintos dibujaban línea visible para el mismo borde

- `addShapeOutline` (`GeoModule.extrude`) — corre siempre, en los dos modos.
  Ya en 0.005mm.
- `addMergedContourPickLines` — corría solo en piezas fusionadas, y hacía
  **dos cosas mezcladas en una función**: áreas invisibles de click
  (`addArea`, necesarias — un área rellena es un objetivo de click mucho
  más cómodo que una línea) y una **segunda línea visible** (`addLine`,
  offset 0.12mm) que resultó **no ser un duplicado inútil**: es la que el
  resaltado de selección (`PanelUI.refreshContourVisuals`, busca objetos
  `isLine` con `_pickContourIdx`) pone en blanco cuando seleccionás ese
  sub-contorno para re-extruirlo. Borrarla sin más habría hecho perder esa
  señal visual.

### Solución: un mecanismo por propósito, no uno por modo

En vez de "una función que dibuja Y detecta click", se separó por trabajo:

1. **Dibujar** — sigue siendo solo `addShapeOutline`, sin cambios de fondo.
   Ahora, si quien llama a `GeoModule.extrude()` marcó una forma con
   `shape._pickCIdx = <índice de contorno>` (hecho por el código que arma
   piezas fusionadas, antes de extruir), la línea de esa forma se crea
   **una sola vez** pero con material propio (clonado) y con
   `_pickContourIdx`/`_pickFace`/`_pickMesh` — la misma línea sirve de
   contorno decorativo y de indicador de selección.
2. **Detectar click** — `addMergedContourPickAreas` (antes
   `addMergedContourPickLines`, renombrada porque ya no dibuja líneas):
   solo las áreas invisibles (`addArea`). Nada visual.

Los 4 sitios que llaman a esto (extrusión 2D fusionada, re-extrusión 3D
fusionada, y los dos de restaurar un proyecto guardado) ahora etiquetan la
forma (`compositeShape._pickCIdx = ...`) **antes** de llamar a
`GeoModule.extrude()`, y después llaman a `addMergedContourPickAreas` solo
para las áreas.

### Por qué esto y no "unificar todo en un solo mecanismo total"

Una línea fina y un área rellena son geometrías distintas por naturaleza
— clickear una línea con precisión de píxel es incómodo; un área rellena
es un objetivo de click natural. Forzar las dos cosas a un solo tipo de
geometría degradaría una de las dos funciones. La separación correcta es
por **propósito** (dibujar vs. detectar click), no por **modo**
(separados vs. unido) — y el dibujo ya era compartido entre modos de por
sí, así que no hacía falta nada especial ahí.

### Verificación

Con Playwright, sobre la misma pieza fusionada de prueba:

| Medición | Antes | Después |
|---|---|---|
| Líneas totales en la pieza (2 sub-contornos) | 8 (4 decorativas + 4 de picking duplicadas) | **4** (una por cara por sub-contorno) |
| Áreas invisibles de picking | 4 | 4 (sin cambios) |
| Línea que se pone blanca al seleccionar el sub-contorno 1, cara top | sí (la duplicada) | **sí (la única que existe)** |
| Gap de re-extrusión | 0.000000mm | 0.000000mm (sin cambios) |

Sin errores de consola. Sintaxis validada con `node --check`.
