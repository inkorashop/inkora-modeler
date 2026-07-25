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
