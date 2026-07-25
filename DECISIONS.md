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

## 2026-07-25 — Investigación: copiar/pegar desde CorelDRAW sin macro (Ctrl+C → Ctrl+V)

### Pregunta

¿Se puede tener el flujo "Ctrl+C en CorelDRAW → Ctrl+V en INKORA" (import
directo de vectores, sin exportar/importar archivo a mano) **sin** depender
de una macro VBA instalada dentro de Corel?

### Qué existía antes (en `Viejo/`, nunca portado a `inkora-3d-modeler-v10-corregido.html`)

Se probaron y documentaron **tres enfoques distintos**, todos ya implementados
en algún momento de la historia del proyecto (lineage `v25` / `VIEJO 2`), pero
ninguno vive en la versión actual (`v10`):

1. **Macro VBA dentro de Corel** (`Viejo/InkoraCopySvg.bas`,
   `Viejo/VIEJO 2/corel/INKORA-Corel.bas`) — el enfoque que terminó
   funcionando y quedó documentado como el flujo "oficial" en
   `VIEJO 2/LEEME.md`. El usuario instala la macro una vez (Alt+F11 →
   GlobalMacros → Importar archivo), la ejecuta con la selección activa, y
   esta exporta la selección a un DXF temporal (`ActiveDocument.ExportEx`
   con filtro `CDR_DXF`, rango `CDR_SELECTION`) y escribe ese texto
   directo al portapapeles de Windows como `CF_UNICODETEXT` (API Win32
   `OpenClipboard`/`SetClipboardData`, sin dependencias externas). Después,
   en INKORA, un listener de `paste` en el `document` (ver `VIEJO 2/js/main.js`
   y `v25`, líneas ~6989-7037) detecta el texto DXF (o SVG) en
   `clipboardData` y lo pasa por el **mismo parser que usan los archivos
   .dxf/.svg** — cero código de importación duplicado.

2. **Helper externo sin ninguna macro** (`Viejo/inkora-clipboard-helper.ps1`)
   — exactamente lo que se preguntó ahora. Un script PowerShell/.NET
   standalone (con panel flotante + ícono de bandeja, mismo patrón visual
   que la tarjeta de actualización que armamos para el instalador) que:
   - Se registra como listener nativo de cambios de portapapeles
     (`AddClipboardFormatListener`, Win32).
   - Cuando el portapapeles cambia, revisa si la ventana en foreground era
     CorelDRAW.
   - Si lo era, se conecta a CorelDRAW **por COM/automatización externa**
     (`[Runtime.InteropServices.Marshal]::GetActiveObject("CorelDRAW.Application")`)
     — no una macro, sino el mismo mecanismo que usan Excel/Word para
     automatizarse desde Python o PowerShell sin tocar VBA.
   - Si conecta, exporta la selección activa a SVG (`doc.ExportEx(...,
     cdrSVG, cdrSelection)`) y **reemplaza** el contenido del portapapeles
     por ese SVG como texto plano — para cuando el usuario hace Ctrl+V en
     el navegador/Electron, lo único que hay ahí es SVG, un paste
     estándar sin ningún permiso especial.
   - El gesto del usuario en Corel queda **100% nativo**: Ctrl+C normal,
     sin macro, sin botón, sin instalar nada dentro de Corel.

3. **Fallback 100% manual** (botón "Pegar SVG" + modal, ver `v25` líneas
   ~472-475 y ~587-605): el usuario exporta a mano desde Corel (`Archivo →
   Exportar para Web → SVG`), abre el .svg en el Bloc de notas, Ctrl+A,
   Ctrl+C, y pega el texto en un `<textarea>` dentro de INKORA. Cero
   automatización de ningún tipo — ni macro ni COM — pero tampoco es
   "Ctrl+C directo".

### Hallazgo clave: el enfoque 2 (sin macro) ya se probó y falló en la práctica

`Viejo/inkora-helper.log` es un log real de una sesión de uso del helper de
PowerShell (2026-05-16). **Cada intento** de conexión registrado terminó en
el mismo error:

```
ERROR CorelDRAW COM: Excepción al llamar a "GetActiveObject" con los
argumentos "1": "Operación no disponible (Excepción de HRESULT:
0x800401E3 (MK_E_UNAVAILABLE))"
```

`MK_E_UNAVAILABLE` en este contexto significa: CorelDRAW no se registró a
sí mismo en la **Running Object Table** (ROT) de Windows, así que ningún
proceso externo puede "engancharse" a la instancia ya abierta vía
`GetObject`/`GetActiveObject`. Esto es un problema conocido y documentado
en la comunidad de scripting de Corel (no específico de esta PC ni de esta
versión) — CorelDRAW es inconsistente registrando su objeto COM en la ROT
según versión, y una macro VBA **no sufre esto** porque corre adentro del
proceso de Corel y ya tiene la referencia viva (`ActiveDocument`,
`Application`) sin necesidad de buscarla desde afuera.

`Viejo/VIEJO 2/ACTUALIZACIONES.md` (entrada v2.0.0) confirma que el
proyecto **abandonó el helper a propósito** después de esto:

> "Ya no hace falta el helper de PowerShell: la macro de Corel deja el DXF
> en el portapapeles y el navegador lo recibe con Ctrl+V nativo."

### Conclusión

Con evidencia real (no solo teoría): **no se encontró una forma confiable
de automatizar completamente el Ctrl+C sin algo corriendo dentro de
Corel**. La automatización externa por COM (`GetActiveObject`) es la única
vía "sin macro" investigada hasta ahora, y falló consistentemente por una
limitación de CorelDRAW (no de este proyecto). La macro VBA es la opción
más simple que sí funciona de forma confiable, y el costo de "tener una
macro instalada" es único (una sola vez, `Alt+F11` → importar el .bas) —
no hay que tocarla de nuevo salvo que se reinstale Corel.

### Posibles próximos pasos (no explorados todavía)

- Probar si `GetObject` sin argumentos (`GetObject(, "CorelDRAW.Application")`
  vs. `GetActiveObject` específicamente) se comporta distinto — el log solo
  registra el segundo.
- Investigar si CorelDRAW 2024 (versión actual, `25.0.0.230`) expone algún
  mecanismo de registro ROT distinto o una opción de configuración para
  habilitarlo (no confirmado que exista).
- Alternativa no probada: en vez de leer el portapapeles después del hecho,
  usar **UI Automation (UIA)** para disparar programáticamente el propio
  menú "Exportar" de Corel cuando se detecte Ctrl+C — más frágil (depende
  de la disposición de menús, puede romperse con actualizaciones de Corel)
  y no evita el problema de fondo si el objetivo es cero-automatización.
- Si se retoma el enfoque de macro: ninguna de las dos versiones (`v25`,
  `VIEJO 2`) está portada a `inkora-3d-modeler-v10-corregido.html` todavía.
  El trabajo pendiente sería: (a) portar el listener de `paste` +
  `_importSVGText`/`_importDXFText` + modal "Pegar SVG" desde `v25` (código
  ya escrito y probado, solo falta portarlo — `SVGParser` y `DXFParser` ya
  existen en v10, la parte difícil ya está hecha), y (b) decidir si instalar
  la macro `.bas` en la instalación actual de Corel del usuario.

Sin errores de consola. Sintaxis validada con `node --check`.

## 2026-07-25 (seguimiento) — Ctrl+V portado a v10 + decisión: sí macro

Retomando lo de arriba: el usuario confirmó explícitamente que prefiere la
**macro VBA** (la única vía que probó funcionar) en vez de reintentar COM/UI
Automation o quedarse solo con el fallback manual. Con esa decisión tomada,
se portó el flujo completo a `inkora-3d-modeler-v10-corregido.html`.

### Qué se portó (no se copió v25 completo — se adaptó a la arquitectura de v10)

`DXFParser` y `SVGParser` de v10 usaban `loadFile(file)` con `FileReader`
como único punto de entrada. Se dividió cada uno en:

- `loadFile(file)` — sigue leyendo un `File` con `FileReader`, ahora delega
  el parseo a `loadText`.
- `loadText(text)` — el parseo real (tokenize/hierarchy en DXF; SVGLoader +
  cómputo de huecos en SVG), a partir de texto ya en memoria.

Esto evita duplicar el parser para el caso "texto pegado" (a diferencia de
v25, que para DXF pegado envolvía el texto en un `File` sintético con
`new File([dxfText], ...)` solo para poder llamar a `loadFile` — funcional,
pero un rodeo innecesario ahora que `loadText` existe directamente).

En `loadDXF(file)` (el handler de importar archivo/arrastrar), la parte que
arma `State.contours` a partir de `shapeData` se extrajo a
`populateShapeData(shapeData, filename)` — reusada tanto por import de
archivo como por lo pegado, para que exista un solo lugar que "puebla la
escena desde una lista de shapes ya parseada".

Se agregó:

- `importPastedText(text, sourceName)` — detecta si el texto es DXF
  (`_looksLikeDXFText`: busca `0\nSECTION` + `2\nENTITIES`) o SVG
  (`_looksLikeSVGText`: empieza con `<svg`, o contiene `<svg ` / `<?xml`),
  llama al `loadText` del parser correspondiente, y llama a
  `populateShapeData`.
- Listener `document.addEventListener('paste', ...)` — ignora el evento si
  el foco está en un `INPUT`/`TEXTAREA` (para no romper el paste normal de
  esos campos), intenta leer `image/svg+xml` de los `clipboardData.items`,
  si no hay cae a `text/plain`, y como último recurso busca un `<svg>...`
  embebido en `text/html`. Si nada matchea, no hace `preventDefault` —
  deja que el paste siga su curso normal.
- Botón **"Pegar SVG"** en el header + modal (textarea) — fallback 100%
  manual, sin macro ni COM: exportás SVG a mano desde Corel, pegás el texto,
  clic en "Importar". Llama al mismo `importPastedText`.

### Qué NO se portó de v25

El `SVGParser` de v25 es una implementación manual completamente distinta
(parsea el DOM del SVG a mano, con su propio `computeHier`/`colorSource`) a
la de v10 (basada en `THREE.SVGLoader` + `DXFParser.computeHierarchy`
reusada). Se decidió **no** reemplazar el `SVGParser` de v10 por el de v25
— haría eso sería introducir una segunda implementación de parseo SVG con
comportamiento distinto al que ya tienen los `.svg` importados por archivo
en v10, rompiendo justo el principio de "un solo parser para archivo y para
pegado" que es el objetivo de este cambio. En cambio, se le agregó
`loadText` al `SVGParser` que ya vive en v10.

### Instalación de la macro

Se copió `Viejo/InkoraCopySvg.bas` (sin modificarlo) a `corel-macro/` en la
raíz del proyecto, junto con `corel-macro/LEEME.md` con los pasos de
instalación (`Alt+F11` → importar `.bas`) y una nota de por qué es macro y
no COM externo. `Viejo/` no se tocó.

### Verificación

Con Chrome DevTools MCP, sobre `inkora-3d-modeler-v10-corregido.html`
abierto directo (`file://`):

- Disparado un evento `paste` sintético con un SVG de rectángulo en
  `clipboardData` (`text/plain`) → importado correctamente ("1 contorno(s)
  cargados"), extruido sin problemas.
- Modal "Pegar SVG" con un DXF de prueba pegado a mano en el textarea →
  importado correctamente, modal se cierra solo al confirmar con éxito.
- Sin errores nuevos en consola (el único error registrado es un warning
  de seguridad de Chrome sobre `file://` no relacionado con este cambio).

## 2026-07-25 (bug no relacionado) — El panel de color se cerraba al soltar el slider de gama, no al elegir el color

### Síntoma

Al cambiar el color de una pieza: mover el slider de gama (canvas
`color-hue`, para ir p. ej. de verde a rojo) y soltarlo cerraba el popover
inmediatamente, sin dar tiempo a clickear después el cuadrado de
saturación/brillo (`color-square`) para elegir el tono final dentro de esa
gama.

### Causa raíz

En el IIFE del color picker, el listener global de `pointerup` cerraba el
popover si `active` tenía cualquier valor truthy, sin distinguir cuál de
los dos controles se había soltado:

```js
window.addEventListener('pointerup', () => {
  if (active) closePicker(true);
});
```

`active` vale `'square'` mientras se arrastra el cuadrado, o `'hue'`
mientras se arrastra el slider de gama — ambos casos disparaban el cierre.

### Solución

Solo el cuadrado representa "elegir un color efectivamente" (gama + brillo
ya definidos). Soltar el slider de gama debe dejar de arrastrar sin cerrar:

```js
window.addEventListener('pointerup', () => {
  if (active === 'square') closePicker(true);
  active = null;
});
```

### Verificación

Con Chrome DevTools MCP: simulado `pointerdown` + `pointermove` +
`pointerup` sobre `#color-hue` → el popover queda abierto
(`display:block`). Simulado el mismo gesto sobre `#color-square` → el
popover se cierra (`display:none`), confirmando que el commit de color
sigue funcionando igual que antes.

## 2026-07-25 — El highlight de hover/selección siempre "lavaba" el color hacia blanco

### Síntoma

Al posar el mouse o seleccionar una pieza extruida (o un contorno 2D),
el resaltado se veía casi siempre como un lavado hacia blanco/gris: en
piezas negras o de colores saturados (rojo, azul, etc.) quedaba
demasiado claro/blanquecino; en piezas blancas casi no se notaba
cambio.

### Causa raíz

`Viewport._applyHighlight(mesh, mode)` calculaba correctamente la
luminancia del color base y decidía "aclarar" o "oscurecer" según
corresponda, pero la rama de aclarado para colores oscuros/saturados no
tocaba el color real: sumaba un **glow `emissive` blanco parejo**
(`emissive = 0xffffff`, intensidad 0.22 hover / 0.42 select) en vez de
mezclar el color base hacia blanco. Un `MeshStandardMaterial` con
emissive blanco se ve lavado hacia blanco/gris sin importar el matiz
del color base — por eso negro, rojo o azul se veían todos tirando a
blanco en vez de "negro más claro" o "rojo más claro". La rama de
piezas claras sí modificaba el color real (`multiplyScalar`), por eso
el problema solo aparecía para la mitad oscura/saturada de la paleta.
El hover 2D (`setHoverVisual`, rama no extruida) tenía un problema
menor análogo: aclaraba con `color.addScalar(0.20)`, un desplazamiento
parejo por canal que no escala con la intensidad hover/select ni es
consistente con la lógica 3D.

### Solución

Una sola mezcla de color, simétrica en ambas direcciones, sin
`emissive`: el color base se interpola (`THREE.Color.lerp`) hacia
negro (si es claro, `lum > 0.45`) o hacia blanco (si es oscuro), en
una proporción fija según el modo — `HIGHLIGHT_MIX_HOVER = 0.22` /
`HIGHLIGHT_MIX_SELECT = 0.42`, las mismas dos constantes que antes eran
implícitas en el emissive. Al mezclar el color real (no sumar luz
encima) el matiz se conserva: un rojo resaltado se ve rojo más claro,
no gris/blanco. El hover 2D (`setHoverVisual`) se alineó a la misma
fórmula y a la misma constante `HIGHLIGHT_MIX_HOVER`, reemplazando el
`multiplyScalar`/`addScalar` ad hoc que tenía antes — un solo mecanismo
para decidir "cómo se ve resaltado un color", no una fórmula por caso.

### Verificación

Con Chrome DevTools MCP, extruyendo una pieza y forzando su color a
cinco valores de prueba, comparando antes/después:

| Color base | Hover (antes) | Hover (después) | Select (antes) | Select (después) |
|---|---|---|---|---|
| `#000000` (negro) | color `#000000` + emissive blanco 0.22 (lavado) | `#383838` | color `#000000` + emissive blanco 0.42 (lavado) | `#6b6b6b` |
| `#ffffff` (blanco) | `#adadad` | `#c6c6c6` | `#7f7f7f` | `#939393` |
| `#ff0000` (rojo) | `#ff0000` + emissive blanco 0.22 (lavado a rosa/blanco) | `#ff3838` (rojo más claro) | `#ff0000` + emissive blanco 0.42 (lavado) | `#ff6b6b` (rojo más claro) |
| `#0000ff` (azul) | (mismo problema que rojo) | `#3838ff` (azul más claro) | (mismo problema que rojo) | `#6b6bff` (azul más claro) |
| `#808080` (gris medio) | `#575757` | `#636363` | `#404040` | `#4a4a4a` |

Select siempre más fuerte que hover en ambas versiones; la diferencia
es que ahora el matiz del color base se conserva en vez de lavarse a
blanco. Sin errores de consola. Sintaxis del archivo completo validada
con `node --check`.

## Seguimiento (mismo día) — el mismo fix, pero con los números equivocados

Con capturas de pantalla reales del viewport (no solo leyendo el hex del
material), el fix de arriba seguía sin notarse: negro quedaba demasiado
claro, blanco casi no se oscurecía. La lógica (mezclar hacia
blanco/negro según luminancia) era correcta — los **valores** (0.22
hover / 0.42 select) no.

### Causa: los valores se habían calibrado contra el color plano, no contra el render real

El viewport usa `THREE.ACESFilmicToneMapping` (exposure 1.05) más tres
luces (`AmbientLight` 0.45, `DirectionalLight` sol 1.2, `DirectionalLight`
relleno 0.45 — ver `setupScene`). Dos efectos que un cálculo de color
plano no contempla:

1. **Oscurecer un color claro casi no se nota.** Un blanco con el
   albedo bajado a la mitad (`lerp` 0.5 hacia negro) sigue iluminado por
   ~2.1x de luz de escena — el resultado antes del tonemap sigue
   saturado cerca de 1.0, y ACES comprime fuertísimo esa zona alta. Solo
   se empieza a notar un gris real pasado ~0.85 de mezcla hacia negro
   (confirmado leyendo píxeles reales del canvas con
   `renderer.readPixels`, no estimando).
2. **Aclarar un color oscuro subiendo el albedo se vuelve a lavar a
   blanco.** Es exactamente el mecanismo del bug original: cualquier
   suba de albedo en una pieza iluminada se multiplica de nuevo por las
   luces de escena y se vuelve a comprimir hacia blanco en el tonemap.
   Por eso la primera versión de este fix, aunque ya no usaba `emissive`
   fijo en blanco, seguía viéndose lavada — el problema no era "blanco
   parejo" sino "cualquier cosa que dependa de re-iluminar el albedo".

### Solución: medir píxeles reales, no asumir la teoría de color plano

Con Chrome DevTools MCP + `Viewport.getRenderer().domElement` +
`gl.readPixels()`, se midió la curva real de brillo renderizado para
varios valores de mezcla, en vez de adivinar:

| Mezcla hacia negro (blanco) | Píxel renderizado (R) |
|---|---|
| 0 (base) | 230 |
| 0.5 | 217 |
| 0.7 | 201 |
| 0.85 | 169 |
| 0.9 | 145 |

Con esa curva medida se recalibraron las constantes:

- **Colores claros** (`lum > 0.45`): se mantiene la mezcla de color real
  hacia negro, pero con valores mucho más agresivos de lo que la teoría
  de color plano sugeriría — `HIGHLIGHT_DARKEN_HOVER = 0.70`,
  `HIGHLIGHT_DARKEN_SELECT = 0.88`.
- **Colores oscuros/saturados** (`lum ≤ 0.45`): en vez de tocar el
  albedo (que se vuelve a lavar por las luces), se le agrega un
  `emissive` — que en three.js se suma directo, sin volver a
  multiplicarse por las luces de escena, así que es predecible — pero
  **teñido con el propio color base** (`orig.lerp(blanco, 0.5)`) en vez
  de blanco puro, para que el brillo agregado se vea "rojo más claro" o
  "gris" y no un flash blanco genérico. `HIGHLIGHT_GLOW_HOVER = 0.18`,
  `HIGHLIGHT_GLOW_SELECT = 0.40`.

### Por qué no unificar en un solo mecanismo (todo emissive o todo albedo)

Emissive no puede oscurecer (solo suma luz), así que los colores claros
siguen necesitando la mezcla de albedo. Y el albedo no puede aclarar de
forma predecible en una pieza ya iluminada (ese es el bug). Cada
dirección necesita el mecanismo que sí controla ese sentido del cambio
de forma predecible — la rama que decide cuál usar sigue siendo una
sola (`lum > 0.45`), no se duplicó nada.

### Verificación

Con Chrome DevTools MCP, extruyendo 3 piezas (negro, blanco, rojo) y
leyendo píxeles reales del canvas (`gl.readPixels`) antes/después de
aplicar cada highlight con el código real (`Viewport.applyHighlight`,
sin duplicar la lógica en el test):

| Color | Base (RGB aprox.) | Hover | Select |
|---|---|---|---|
| Negro | 36,38,44 | ~90-105 (gris) | ~142-145 (gris medio) |
| Blanco | 230,230,231 | ~201 (gris claro) | ~155-170 (gris medio) |
| Rojo `#ff0000` | 241,111,76 | 241,146,124 (rojo más claro) | 241,171,158 (salmón) |

Select siempre más fuerte que hover; negro y blanco convergen a un gris
medio similar en `select` (buscado, se ve como "resaltado" sin importar
el color de origen); los colores saturados conservan su matiz en vez de
lavarse. Confirmado también con capturas de pantalla del render
completo, no solo valores de píxel aislados. El caso 2D (contornos no
extruidos, `MeshBasicMaterial` sin luces) no sufre este problema —
medido aparte, la mezcla existente (0.22) ya se ve bien porque no hay
relighting ni tonemap agresivo de por medio. Sin errores de consola.
Sintaxis del archivo completo validada con `node --check`.

## 2026-07-25 -- Investigacion: solapes visuales de SVG/Corel aparecen como paredes al extruir (NO IMPLEMENTADO)

### Sintoma observado

En un diseno tipo tucan, al seleccionar visualmente solo una parte del pico
y extruir, aparece una pieza mucho mas grande de lo esperado: se extruyen
zonas de la base negra y quedan paredes finas en limites donde, en CorelDRAW,
otra pieza coloreada esta perfectamente apilada encima.

El problema tambien se reprodujo importando SVG, asi que no corresponde al
ultimo fix de absorcion de huecos (`e5bd6f1`) ni es especifico de Electron.
Es un problema anterior del modelo de importacion: la app interpreta la
geometria vectorial completa de cada shape, no el resultado visual final
despues de apilar capas/formas.

### Estado anterior documentado para rollback

Estado vigente antes de implementar cualquier solucion nueva:

- `SVGParser.loadText()` usa `THREE.SVGLoader.parse()` y
  `THREE.SVGLoader.createShapes(path)`.
- Cada shape exterior y cada hole del SVG se aplana como contorno
  independiente en `flat`.
- Luego `DXFParser.computeHierarchy(flat.map(f => f.shape))` recalcula
  solamente `parentIdx` y `depth` por contencion geometrica.
- `computeHierarchy` no hace booleanos, no resta formas superiores de formas
  inferiores, no divide regiones visibles desconectadas y no usa el orden de
  pintado del SVG/Corel como composicion visual.
- El handler de `btn-extrude` recibe esos contornos ya generados y solo decide
  que hijos se agregan como holes y cuales se absorben como parte del mismo
  elemento (`sameElementForAutoTopology`). Ese fix evita que un contorno de
  otro elemento desaparezca, pero no puede eliminar geometria que ya fue
  importada debajo de otra capa.

Punto seguro de referencia: commit `e5bd6f1` (`Corregir absorcion de contornos
al extruir`). Si una futura implementacion de resolucion de solapes sale mal,
volver a este estado restaura el comportamiento actual conocido: seleccion y
extrusion funcionan sobre contornos completos, con la limitacion de que las
formas inferiores siguen existiendo debajo de las superiores.

### Causa raiz

Corel/SVG permiten construir ilustraciones por apilado: una base negra grande
puede existir completa por debajo, y piezas naranjas, blancas o grises pueden
tapar partes de esa base de forma pixel-perfect. Visualmente no hay material
negro debajo de esas piezas, pero vectorialmente si lo hay: la forma negra no
fue recortada, solo quedo cubierta.

INKORA hoy importa cada fill como si todo su area fuera material real. Por eso,
al extruir una forma inferior o una region relacionada con ella, aparece
geometria escondida bajo otras capas y se ven paredes finas en los bordes de
las formas superiores. El 3MF/exportador no es la causa: exporta lo que ya
existe en `State.pieces`.

### Solucion propuesta

Agregar una etapa de preprocesamiento de SVG antes de `computeHierarchy`:
resolver la geometria visible por orden de pintado.

Algoritmo propuesto para SVG:

1. Parsear y aplanar los fills en orden de documento/pintado, conservando
   `pathIndex`, `shapeIndex`, `layer`, `color` y un `sourceElementId`.
2. Convertir cada fill a poligono booleano robusto, incluyendo sus holes.
3. Procesar de arriba hacia abajo manteniendo `coveredAbove`, la union de todo
   lo que ya fue pintado encima.
4. Para cada shape: `visible = paintedShape - coveredAbove`.
5. Si `visible` queda vacio o menor a un umbral de area, descartarlo.
6. Si `visible` se divide en varias islas, emitir cada isla como contorno
   seleccionable separado.
7. Si una isla visible tiene holes reales, emitir exterior + holes con un
   mismo `elementId`/`visiblePartId`, para que la extrusion los trate como una
   sola pieza con huecos.
8. Recalcular `parentIdx`/`depth` sobre los contornos visibles resultantes y
   continuar con el pipeline actual (`populateShapeData`, seleccion,
   extrusion, historial y exportacion).

La solucion debe vivir en importacion, no en extrusion. El boton Extruir debe
seguir trabajando con contornos ya limpios/visibles; asi el mismo arreglo sirve
para exportar 3MF, abrir en laminador, guardar proyecto y reextruir.

### Alcance recomendado

Primera implementacion solo para SVG/Corel, porque SVG conserva mejor el orden
visual de pintado. DXF no siempre preserva un orden de dibujo confiable, asi
que para DXF conviene mantener el comportamiento actual hasta confirmar que el
export de Corel incluye una senal estable de orden/capa.

La implementacion deberia quedar aislada detras de una funcion/modulo nuevo,
por ejemplo `SVGVisibleGeometry.resolve(flat)`, para que sea facil desactivarla
o revertirla sin tocar la extrusion.

### Que NO conviene hacer

- No corregir esto con tolerancias o offsets de contornos: esconderia paredes
  pero cambiaria dimensiones reales.
- No intentar deducirlo desde el click/seleccion: ahi ya se perdio el orden
  visual y la forma inferior ya entro completa.
- No hacer booleanos directamente en 3D: es mas caro, mas fragil y llegaria
  tarde. El problema es 2D y debe resolverse antes de crear `State.contours`.

### Plan de verificacion cuando se implemente

- SVG minimo: rectangulo negro abajo + rectangulo naranja encima. Al importar,
  el negro visible debe quedar recortado; extruir naranja no debe generar pared
  negra debajo.
- SVG tipo tucan: el pico naranja/gris/blanco debe quedar separado segun lo
  visible en Corel; seleccionar una parte debe extruir solo esa region.
- Letras o formas con holes reales del mismo path deben seguir extruyendo con
  huecos correctos.
- Formas donde una capa superior divide una inferior en varias islas deben
  aparecer como contornos separados.
- Proyectos `.inkora3d` viejos deben cargar igual que antes, porque ya guardan
  contornos resueltos y no pasan de nuevo por el importador.

## 2026-07-25 — La barra superior no era responsive (se recortaba en ventanas angostas)

### Síntoma

En navegadores/ventanas más angostas (laptops, ventanas divididas), los
~13 botones del header (con texto completo: "Importar DXF/SVG", "Abrir
proyecto", "Exportar 3MF", etc.) no entraban en el ancho disponible.
`#header` era un `flex` simple sin `overflow` ni `flex-wrap` ni ningún
`@media` — no había ni un solo media query en todo el archivo. El
contenido que no entraba quedaba directamente invisible (recortado por
`body{overflow:hidden}`), no scrolleable ni reorganizado.

### Solución: dos capas, no una sola

Primer intento: ocultar el texto de cada botón bajo un breakpoint y
dejar solo íconos (con `title` como tooltip). Descartado — el pedido
explícito era que los botones se achiquen, no que pierdan el texto.
Solución final:

1. **Achicar, no ocultar** (`@media (max-width:1500px)` y
   `(max-width:1250px)`): dos escalones que reducen `padding`,
   `font-size` y `gap` de `.btn` dentro del header. El texto de cada
   botón nunca desaparece, solo ocupa menos espacio — a 1366px (laptop
   típica) ya se ve claramente más compacto; a 1100px sigue entrando
   todo sin necesidad de scroll.
2. **Red de seguridad** (`overflow-x:auto` en `#header`, mismo patrón
   que ya usaba `#project-tabs`): si aun con los botones achicados al
   mínimo una ventana es demasiado angosta (~1024px o menos, ventanas
   divididas muy chicas), el header scrollea horizontalmente en vez de
   recortar contenido de forma invisible. Nunca queda un botón
   inalcanzable, aunque haga falta un scroll corto para el último.

Se necesitan las dos: sin la capa 1, cualquier ventana de laptop normal
obligaría a scrollear constantemente para algo tan básico como
"Extruir". Sin la capa 2, un caso extremo (ventana muy angosta) seguiría
rompiendo silenciosamente.

### Verificación

Con Chrome DevTools MCP, emulando viewports de 1600px (tamaño
completo), 1366px y 1100px (achicado, todo visible sin scroll:
`header.scrollWidth === clientWidth` en ambos) y 1024px (`scrollWidth
1093 > clientWidth 1024` → confirmado que scrollea un poco para el
último botón en vez de recortar). Sin errores de consola. Sintaxis del
archivo completo validada con `node --check`.
