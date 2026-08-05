# Decisiones técnicas — INKORA 3D Modeler

Este archivo documenta decisiones de arquitectura y bugs de raíz corregidos,
para que no se reintroduzcan por accidente en trabajo futuro (humano o IA).

## 2026-08-05 (seguimiento 2) — DXF: CorelDRAW duplica relleno+contorno como dos entidades, rompía la "D" de Cataratas

### Síntoma

En `Cataratas.dxf`, el hueco de la letra "D" detectaba mal — la selección
era inconsistente, similar en superficie al bug de la "A" pero de causa
distinta.

### Causa raíz

El hueco de la "D" (contorno 40 en ese momento) tenía **dos hijos con
geometría idéntica** (distancia 0.00000mm entre ellos): mismo color, mismo
padre, mismo nivel, pero **dos entidades DXF distintas**. Revisando el DXF
crudo se encontraron **10 pares así** en todo el documento, todos con la
misma firma: una entidad con color ACI 134, otra con ACI 7, mismo layer,
mismo owner, geometría idéntica.

No es un error aislado del archivo — es un comportamiento conocido del
exportador DXF de CorelDRAW: un objeto con **relleno y contorno/trazo** a la
vez (que en Corel es un solo objeto) se exporta como **dos entidades DXF
separadas** que trazan el mismo borde, porque DXF no tiene forma de
representar esa combinación en una sola entidad. `dedupeShapes()` (dedup de
entrada, sobre curvas crudas antes de Clipper) no los agarra: las dos
entidades no son necesariamente bit-idénticas en su representación cruda,
y recién convergen a la misma geometría después de pasar por la grilla de
Clipper.

Importante: esto es DISTINTO del patrón de "frontera coincidente" de
GEOMETRY_PIPELINE §13 (fondo + relleno superpuesto con roles de diseño
distintos, ej. la "A"). Ese patrón siempre aparece entre **padre e hijo**,
con colores de capas diferentes. El duplicado de relleno/contorno siempre
aparece entre **hermanos** — mismo padre, mismo nivel — así que son
distinguibles y no hace falta (ni conviene) resolverlos con la misma regla.

### Solución

`dedupeSiblingShapes()`, nueva, corre en `DXFParser.loadText()` después de
un primer `computeHierarchy()` (necesita padre/nivel para saber quién es
hermano de quién) y, si sacó algo, recalcula la jerarquía sobre el set ya
filtrado — los índices de padre cambian. Compara sólo dentro de cada grupo
(mismo padre, mismo nivel), primero por área (barato, descarta la mayoría)
y recién después por distancia geométrica real entre los puntos ya
muestreados por `computeHierarchy`. Se queda el que aparece después en el
archivo — mismo criterio que ya usa `dedupeShapes()`.

**Guarda explícita:** nunca compara ni descarta un ítem marcado
`isVoid`/`syntheticVoid`. `applyMaterialVoids()` ya deja a propósito un
marcador de vacío geométricamente idéntico a un hermano visible (ej. un
compuesto DXF cuyos dos anillos comparten especificación de color: el
anillo interior sobrevive como entidad visible Y como marcador de vacío,
mismo lugar, roles opuestos). La primera versión de este fix no tenía esta
guarda y rompía exactamente ese test (`dxfSameSpecDonut`) — se detectó
porque `npm run test:geometry` lo agarró antes de commitear, no en uso real.

Alcance: sólo DXF. SVG no tiene este problema por construcción — Corel
exporta SVG como paths compuestos (un `<path>` por color, con sub-trazados),
donde relleno y trazo son atributos del mismo elemento, no dos entidades
separadas (confirmado: `Cataratas.svg` tiene 5 `<path>` en total contra 81
`LWPOLYLINE` en el DXF equivalente).

### Verificación

`npm run test:geometry` completo en verde. `Cataratas.dxf` pasa de 119 a
115 contornos (4 pares deduplicados en este archivo puntual — los otros 6
pares del DXF crudo no llegaban a sobrevivir como hermanos separados en la
jerarquía final), 1 vacío real, 4 colores, 0 mallas inválidas en los dos
modos de extrusión. El test sintético del compuesto DXF con especificación
de color compartida sigue en verde después de la guarda.

## 2026-08-05 (seguimiento) — Descartado: offset cero en contorno/área + polygonOffset en la cara

### Qué se probó

A pedido del usuario, reemplazar el offset geométrico real de la línea de
contorno 3D (`capZs` en `addShapeOutline`, 0.005mm) y del área de picking/
resaltado (`addMergedContourPickAreas`, 0.16mm) por offset **cero** —
dibujarlas exactamente sobre la posición real de la cara — compensando el
z-fighting con `polygonOffset` positivo en el material de la cara sólida
(`mat` en `GeoModule.extrude()`), en vez del offset geométrico.

Es la técnica estándar para overlays coplanares (decals/wireframes) y en
teoría es correcta: `POLYGON_OFFSET_FILL` sí afecta triángulos (la cara),
así que empujar la cara hacia atrás en el z-buffer debería alcanzar para que
la línea/área, en su Z real y sin ningún offset, gane el z-test siempre.

### Por qué no sirvió

Probado sobre `Cataratas.dxf` en modo unido: con offset cero aparece
z-fighting mucho **peor** que el escalón original, en forma de parches
irregulares en toda la pieza — no solo en el contorno, sino también en las
áreas internas (hojas, ondas del agua). Aislado con una prueba (offset cero
+ `polygonOffset` positivo en la cara vs. offset original + el mismo
`polygonOffset`): el problema no es el signo del offset — con el offset
geométrico original restaurado y `polygonOffset` positivo en la cara, el
render vuelve a ser limpio. Es específicamente la coincidencia geométrica
exacta (offset cero) la que rompe: la línea/área y la cara sólida son
mallas trianguladas de forma **independiente** (`THREE.Line`/`ShapeGeometry`
propios vs. `ExtrudeGeometry` de la pieza), así que en el mismo punto (x,y)
sus vértices no caen en exactamente los mismos triángulos ni la misma
interpolación de profundidad. La magnitud de `polygonOffset` que tolera esta
GPU/config no alcanza a cubrir ese ruido de precisión cuando la separación
real es cero.

### Conclusión

El offset geométrico real (0.005mm en la línea, 0.16mm en el área) sigue
siendo necesario — no fue una elección arbitraria, es el punto que ya
funciona de forma robusta. `polygonOffset` en la cara no es un sustituto
válido de eso en este proyecto: ayuda como mitigación adicional, pero no
reemplaza tener alguna separación geométrica real. Revertido por completo
(`git diff` en cero contra el commit anterior). No reintentar sin nueva
evidencia — ver GEOMETRY_PIPELINE.md si se agrega este tipo de hipótesis
descartada ahí también.

## 2026-08-05 — Hueco real invisible detrás de una frontera coincidente + Ctrl+Z reseteaba el modo de extrusión

### Síntoma

En `Cataratas.dxf` (diseño por capas denso), el hueco interior de algunas
letras (ej. la "A") no se recortaba: seleccionarlo desde cerca del borde
exterior funcionaba bien, pero clickear cerca del centro del trazo interno
seleccionaba la pieza completa, sin hueco. Al extruir "Objeto unido", esa
letra salía sólida en vez de con su hueco.

### Causa raíz

Ya existía la regla (GEOMETRY_PIPELINE §13): un hijo directo con la misma
área que su padre no es un hueco, es la misma frontera vista desde el otro
lado — típico de un diseño por capas (fondo oscuro + relleno de color
superpuesto, mismo contorno exterior). Esa regla es correcta y se respetó.

El bug: cuando el hueco *real* de esa letra no era hijo directo del fondo
sino nieto (hijo de la capa de relleno superpuesta, que a su vez comparte
borde con el fondo), el código solo miraba hijos directos (`depth+1`) para
calcular huecos, en los 6 lugares que repetían ese patrón (`absorbChildren`,
extrusión separada, extrusión unida ×2, re-extrusión sobre piezas 3D
(`addFaceTopology`), reconstrucción de piezas al restaurar snapshot/proyecto,
y el preview 2D `directHoleShapes`). El hueco quedaba invisible para el
contorno de fondo: se extruía sólido tapando el hueco real, y su área de
picking (sin recortar) competía de forma inconsistente con la del hueco
real, coplanar y con área de bounding box casi idéntica — de ahí que el
click a veces "ganara" un lado y a veces el otro según la posición exacta.

### Solución

`realHoleDescendants(contours, parentIdx, parentDepth, parentShape)`: recorre
los hijos directos y, cuando uno no encierra interior (misma frontera que el
padre), no lo descarta — sigue buscando huecos reales entre **sus** hijos,
sin tocar ni consumir esa capa intermedia (sigue siendo su propia pieza
seleccionable, con su propio color y su propio hueco correcto). Reemplaza el
filtro directo (`depth === parent.depth + 1` + chequeo de encierro) en los 6
sitios mencionados arriba.

Verificado con un mapa de picking punto por punto sobre la letra afectada
(antes: alternancia caótica de contornos en el borde del hueco; después:
transición limpia y consistente) y con la regresión geométrica completa
(`npm run test:geometry`): 0 fallos, 0 aristas no-manifold/winding
inconsistente, laminado real en Bambu Studio sin errores.

### Ctrl+Z reseteaba "objetos separados" / "objeto unido"

Cada snapshot de `History` guardaba `extrudeMode`, así que deshacer/rehacer
lo revertía junto con el resto del estado — aunque el usuario lo hubiera
cambiado a propósito después de esa acción. Es una preferencia de trabajo,
no un dato de la escena: se sacó la restauración de `extrudeMode` de
`restoreSnapshot()` (compartida por undo/redo y por abrir proyecto/pestaña)
y se dejó solo en `loadSnapshotIntoState()`, que es el camino específico de
"abrir un documento" — ahí sí tiene sentido adoptar el modo guardado.

## 2026-08-04 (seguimiento 5) - El import tardaba ~700 ms por estar lejos del origen

### El sintoma

Importar o pegar un diseño mostraba "Leyendo…" cerca de un segundo. Medido
sobre `Modelos/Yaguarete.dxf`: **695 ms** dentro de `DXFParser.loadText()`.

### Donde se iba el tiempo

Perfil de V8 sobre tres corridas, sin instrumentar el codigo: el **90% del
tiempo estaba adentro de ClipperLib**, y mas de la mitad del total en
`bnpFromInt`, `Int128.Int128Mul` y `bnpSubTo` -- o sea **BigInteger**.

Clipper trabaja con enteros (coordenada x SCALE, que acá es 10000) y por
encima de su `loRange` (~4.7e7, o sea ~4745 mm) cambia a aritmetica de 128
bits emulada con BigInteger. Corel no exporta el diseño en el origen sino en
las coordenadas de la pagina: el Yaguarete cae a **~9546 mm** del origen del
DXF. Cruza el umbral, y todo el import se hace por el camino lento.

Comprobado antes de tocar nada: el mismo archivo con las coordenadas
trasladadas al origen a mano baja de 695 ms a **288 ms**, y las funciones de
BigInteger desaparecen del perfil.

### Tres cambios, todos medidos

1. **Resolver centrado en el origen** (`recenterShapes()` en DXFParser, antes
   de cualquier booleana). No hay nada que deshacer: la posicion final la fija
   `offX/offY`, que `loadText()` calcula al terminar sobre esa misma
   geometria. Si aparece un tipo de curva que no sabe trasladar, no toca nada
   y devuelve corrimiento cero -- se pierde la optimizacion, nunca la
   geometria. **695 -> 288 ms.**

2. **Descarte por caja en `overlapFraction()`**. Los llamadores la consultan
   para cada par de contornos, o sea O(n²) booleanas: **9621 llamadas y 176
   ms**, lo mas caro del import. Dos cajas que no se tocan tienen interseccion
   exactamente cero, asi que el descarte no es una aproximacion: mismo
   resultado sin construir los paths ni entrar a Clipper. **176 -> 40 ms.**

3. **No resolver dos veces**. `buildDXFPaintItems()` hacia un dry-run de
   `resolve()` y, cuando no habia nada que reagrupar, devolvia los mismos
   items para que `loadText()` los resolviera otra vez -- ~48 ms repetidos.
   Ahora devuelve `{ items, resolved }` y el llamador reusa el dry-run cuando
   sirve.

Medido en `DXFParser.loadText()`, mediana de cuatro corridas en caliente:

| modelo | antes | despues |
| --- | --- | --- |
| Yaguarete.dxf | 695 ms | **174 ms** |
| Cataratas.dxf | 1225 ms | **538 ms** |
| Tucan.dxf | 51 ms | **28 ms** |

La geometria queda identica: mismos contornos seleccionables, mismos vacios y
mismas areas en los tres modelos, y la regresion completa en verde incluido
el laminado real con Bambu Studio.

### Lo que queda para una proxima vuelta

En Cataratas el 86% de lo que queda (452 de 527 ms) esta en `resolve()`, el
particionado de visibilidad por orden de pintado. Ahi el dry-run no se puede
reusar porque el archivo si tiene contornos tapados y los items se
reagrupan: son dos resoluciones distintas y las dos hacen falta.

`resolve()` recorta cada item contra la union acumulada de todo lo que se
pinto encima, que crece con cada item -- O(n²) en complejidad de poligono.
El mismo descarte por caja que se aplico a `overlapFraction()` deberia servir
ahi (un item cuya caja no toca la union acumulada no necesita recorte), pero
es el corazon del contrato geometrico de la app y merece su propia vuelta con
la regresion al lado, no un agregado al pasar.

### Lo que se probo y se descarto: recentrar tambien el SVG

Se aplico la misma idea en `SVGParser.loadText()`. **No sirve y hace daño**:
un SVG ya llega chico por su viewBox y nunca cruza el umbral de 128 bits, asi
que el tiempo no se movio (177 ms contra 182 ms, ruido). Pero correr el
trazado sobre otras coordenadas mueve el redondeo a entero de Clipper, y la
regresion lo detecto como **una arista sobreusada en el OBJ de Cataratas**.
Sin beneficio y con costo: revertido, y anotado en el codigo para que no se
vuelva a intentar.

Vale como advertencia general: trasladar geometria antes de una booleana no
es gratis, cambia el redondeo. Se hace donde el beneficio esta medido.

## 2026-08-04 (seguimiento 4) - Las piezas blancas de un DXF no se podian seleccionar

### El sintoma

En `Modelos/Yaguarete.dxf` habia regiones que el programa no dejaba
seleccionar ni extruir: no respondian al click. El mismo diseño en
`Yaguarete.svg` funcionaba entero. Medido con el pipeline real, no a ojo:
el DXF daba 66 contornos seleccionables y 10 vacios; el SVG, 118 y 1. Las
regiones perdidas eran exactamente las 7 formas blancas del diseño (ojos,
hocico, almohadillas), mas nada.

### La causa

No era el click ni el render: esas 7 formas llegaban marcadas
`isVoid: 'dxf-inferred'`, y `Utils.isVisibleContour()` descarta todo
`_isVoid`. O sea, el import las tomaba por agujeros.

El DXF no guarda relleno. Peor: **en DXF el indice ACI 7 significa "blanco o
negro segun el fondo"**, asi que Corel exporta con el mismo 7 tanto el negro
del contorno como el blanco del relleno. Y la capa `Capa 1` tambien es color
7, con lo cual la silueta -- que viene ByLayer, sin codigo 62 propio --
resolvia al mismo `#ffffff` que las formas blancas. Entidades consecutivas,
mismo hex, contencion total: exactamente la firma de un trazado compuesto de
Corel. `buildDXFMaterialItems()` las agrupaba como subtrazados de la silueta,
la union de material les quedaba como anillo impar y `applyMaterialVoids()`
las marcaba vacio.

### Decision: la clave de estilo incluye el ORIGEN del color, no solo el hex

`dxfPaintStyleKey()` pasa de `capa|color` a `capa|color|origen`, donde origen
es `true` (codigo 420), `aci` (codigo 62 propio), `layer` (heredado) o `none`.

El criterio no es cosmetico: **los subtrazados de un mismo objeto llevan
siempre la misma especificacion de color** -- los dos anillos de una dona
salen los dos con 62 propio, o los dos ByLayer --, mientras que dos objetos
distintos que casualmente coinciden en el hex final suelen llegar por caminos
distintos. En el Yaguarete eso separa la silueta (ByLayer) de las 7 formas
blancas (62 propio) sin tocar nada mas.

Resultado medido: 66 -> **73 contornos seleccionables**, 10 -> 3 vacios. Los
3 que quedan son el agujero real del llavero -- el mismo unico vacio que
detecta el SVG, con la misma area -- y dos polilineas degeneradas de area ~0.
Identico al resultado de repintar las 7 entidades a mano en el DXF, que fue
como se valido la hipotesis antes de tocar codigo.

`dedupeShapes()` ahora hereda `colorSource` junto con `color`: viajan
pegados, y heredar uno sin el otro deja una clave de estilo mentirosa.

### Lo que esto NO arregla

Si el objeto de abajo tambien trajera codigo 62 propio con el mismo ACI, la
ambiguedad vuelve: desde el DXF solo, ese caso es indistinguible de una dona.
La salida de fondo para eso seria poder rescatar un vacio inferido desde la
UI (convertirlo en pieza con un click). El codigo ya contempla el caso
inverso -- un contorno seleccionado se extruye como pieza independiente en
vez de absorberse como agujero -- pero hoy a un `_isVoid` no se lo puede
seleccionar para llegar ahi.

### Regresion

Dos fixtures nuevos en `testMaterialVoidDetection()`, que son el par minimo
del problema: `dxfWhiteOnBlack` (base ByLayer + pieza con 62 propio, mismo
ACI 7) debe dar 0 vacios, y `dxfSameSpecDonut` (los dos anillos con 62
propio) debe seguir dando 1. `dxfPolyline()` acepta color `undefined` para
emitir ByLayer y `dxfDocument()` acepta un color de capa.

## 2026-08-04 (seguimiento 2) - Reimportar un diseño exportado

### Que se pedia

Volver a traer al programa un diseño ya exportado, con sus tamaños, colores,
nombres y piezas. El 3MF y el OBJ solo transportan triangulos: no llevan los
contornos 2D, ni las alturas de extrusion, ni el bisel, ni la relacion entre
piezas. Reconstruir todo eso desde la malla es imposible en general.

### Decision: el proyecto viaja dentro del propio archivo exportado

Un 3MF **es** un paquete OPC, o sea un ZIP. El laminador entra por
`_rels/.rels`, sigue la relacion a `3D/3dmodel.model` y descarta lo que no
conoce. El exportador ya venia escribiendo dos partes que no son del
estandar (`Metadata/model_settings.config` y `project_settings.config`,
invento de Bambu) y ningun laminador se queja. Se agrega una tercera:

    Metadata/INKORA/project.json

con exactamente el mismo payload que se escribe a un `.inkora3d`. Sin
relacion en `.rels`, para que ningun consumidor la confunda con geometria, y
declarada en `[Content_Types].xml`. Es la unica parte comprimida del paquete
(DEFLATE); el resto queda STORE, tal cual estaba, para no cambiar en nada lo
que ya lee el laminador. En el Tucan: 74 KB de JSON -> 13 KB en el archivo.

El OBJ no tiene contenedor, pero si comentarios `#`, que todo parser del
formato descarta. El mismo payload viaja ahi en base64, entre dos marcas.
Pasados los 8 MB en base64 no se incrusta y se avisa por consola.

**Verificado, no supuesto**: la regresion arma el fixture que va a Bambu
Studio *con* la parte incrustada. Bambu lo lamina igual que antes -- un solo
objeto ensamblado, 0 aristas abiertas, 0 no-manifold, mismo conteo de
triangulos, G-code no vacio. El CLI de Orca en Windows crashea con
`--info`, pero crashea identico sobre un 3MF sin la parte: es su CLI, no el
incrustado.

### Camino de respaldo: reconstruir desde la malla

Para un archivo de otro programa, o uno de INKORA al que le sacaron la
parte, se reconstruye cada pieza uniendo con Clipper sus triangulos
proyectados al plano XY. Para un prisma -- que es lo que produce una
extrusion -- esa union es exactamente su perfil 2D con sus huecos: las
paredes verticales proyectan area cero y el hueco no tiene triangulos que lo
tapen. La altura sale del rango Z y la elevacion del Z minimo.

Se descartan los triangulos con area proyectada menor a la que Clipper ya
rechaza (1e-8 mm2) y se deduplican los que coinciden en planta -- las dos
tapas de un prisma son la misma figura --, lo que baja a la mitad el trabajo.

Lo que ese camino no puede devolver: el bisel (queda en 0) y los parametros
originales. Un modelo con voladizos reales entra por su silueta.

### Por que no se reconstruye una malla arbitraria como pieza suelta

`State` no sabe representar un triangulo suelto: una pieza siempre nace de un
contorno 2D que se extruye, y de ahi dependen el historial, el guardado y la
exportacion. Meter mallas crudas hubiera pedido reescribir ese modelo entero.
La reconstruccion produce contornos y piezas reales, asi que todo lo demas
sigue funcionando sin cambios.

## 2026-08-04 (seguimiento 3) - Guardar un proyecto extruido estaba roto

### Sintoma

Extruir el Tucan, cambiar de pestaña y volver dejaba **0 piezas** y un solo
contorno, con `La union 2D produjo una pieza vacia` en consola. El mismo
camino es el de guardar un `.inkora3d` y reabrirlo: guardar un proyecto ya
extruido y volver a abrirlo no devolvia el modelo. Reproducido tambien en el
`index.html` de HEAD, sin ningun cambio encima: era un bug viejo, no una
regresion nueva.

### Causa

Es el invariante de `GEOMETRY_PIPELINE` §13: un anillo hijo con la misma area
que su padre no es un hueco, es la misma frontera vista desde el otro lado.
En el Tucan pasa cuatro veces (contornos 0/14, 1/13, 7/8, 9/11).

`enclosesInterior()` lo filtra al armar el flat mesh, al absorber hijos y al
restar interiores seleccionados -- pero **no** al restaurar un snapshot.
`piece._holeIdxs` conserva el indice aunque la extrusion lo haya descartado,
asi que `buildSnapshotPieceGeometry()` lo restaba de nuevo, la pieza quedaba
sin material, `unionShapes()` tiraba y la restauracion abortaba en la primera
pieza -- por eso quedaba un solo contorno.

### Correccion

El mismo `enclosesInterior()` en `buildSourceShape()`, dentro de
`restoreSnapshot`. La regresion ahora restaura de verdad el proyecto
incrustado del Tucan y exige las 16 piezas, sus 3 colores y sus medidas.


## 2026-08-04 (seguimiento) - Respaldo por CDN: el HTML suelto tambien arranca

### Sintoma

Se copio `INKORA 3D Modeler.html` solo a otra PC y la app no arrancaba. No
era ninguna dependencia instalada en la PC de origen: el `<head>` carga cinco
librerias con ruta relativa a `vendor/`, y sin esa carpeta al lado no existe
THREE, ni Clipper, ni JSZip. El script principal se rompe en la primera linea
que las toca y la ventana queda en blanco, sin decir por que.

### Decision

`vendor/` sigue siendo el camino principal -- la regla de AGENTS.md de no
apuntar las librerias a un CDN no se revierte. Lo que se agrega es un
**respaldo**: despues de las cinco etiquetas locales, un bloque comprueba
`window.THREE`, `THREE.BufferGeometryUtils`, `THREE.SVGLoader`,
`window.ClipperLib` y `window.JSZip`, y solo pide por red lo que falto.

Con `vendor/` presente -- Electron, portable, instalador, Vercel -- el bloque
sale en la primera comprobacion y no genera **ninguna** peticion. Verificado
interceptando el trafico del renderer: cero pedidos externos.

Sin THREE no se comprueban sus dos complementos por separado: `SVGLoader` y
`BufferGeometryUtils` extienden clases de THREE al evaluarse, asi que si
THREE falto ellos tampoco llegaron a definirse aunque sus archivos locales
existan. Los tres se piden juntos.

### Por que `document.write` y no carga dinamica

El script principal es inline y corre durante el parseo, asi que las
librerias tienen que estar listas antes. `document.write` inserta las
etiquetas en el punto de parseo: mantienen el orden y bloquean igual que las
locales. Con `appendChild` asincronico, el script principal correria primero
y fallaria igual.

Chromium avisa por consola que un script cross-site invocado por
`document.write` **puede** bloquearse en conexiones muy lentas (la
"document.write intervention", pensada para 2G). Es un aviso, no un error:
en las pruebas los cinco archivos cargaron bien. Vale como limitacion
conocida del respaldo, no del camino principal.

### Versiones clavadas y verificadas

Las URLs apuntan a la version exacta que hay en `vendor/` -- three r128
(el codigo usa `examples/js`, no modulos), clipper 6.4.2, jszip 3.10.1 --
y llevan `integrity` + `crossorigin`. Los cinco archivos que devuelven cdnjs
y jsdelivr son **byte-identicos** a los de `vendor/` (mismo sha256), asi que
el respaldo no introduce diferencias de comportamiento.

Al actualizar una libreria hay que tocar las dos puntas: el archivo en
`vendor/` y la URL + hash del respaldo.

### Fallo explicito

Si despues del respaldo sigue faltando algo -- ni `vendor/` ni internet --
un cartel a pantalla completa dice cuales librerias faltaron y como
resolverlo (copiar `vendor/` al lado, conectarse, o usar el `.exe` portable
que ya las trae adentro). Antes ese caso era una ventana en blanco.

### Verificacion

Tres escenarios, cargando el HTML por `file://`:

| escenario | resultado |
| --- | --- |
| con `vendor/` | 0 peticiones externas, THREE r128, app viva |
| sin `vendor/`, con internet | las 5 desde CDN, THREE r128, app viva |
| sin `vendor/`, sin internet | cartel de librerias faltantes |

Regresion geometrica en verde.

## 2026-08-04 - Nombres de elemento, paleta con nombre y seleccion instantanea

### El panel ya no salta al seleccionar

`#sel-badge` se mostraba con `display:none` / `display:inline`. El badge es
mas alto que el texto del titulo de seccion, asi que aparecer lo estiraba y
empujaba unos pixeles todo lo que hay debajo, incluida la lista. Ahora el
badge esta siempre en el flujo y solo cambia `visibility`: el alto de la fila
queda reservado y la lista no se mueve. Medido en regresion: 0 px de
desplazamiento entre antes y despues de seleccionar.

### Seleccionar una fila es instantaneo

Habia dos demoras sumadas:

1. un `setTimeout` de 220 ms sobre `click` cuando el click caia en el nombre,
   para no pisar un posible doble click de renombrado;
2. un `renderList()` completo — se destruia y reconstruia el arbol entero,
   con un `Box3.setFromObject` por pieza para recalcular dimensiones.

La seleccion pasa a `pointerdown` (se ve al apretar, no al soltar) y usa
`refreshListSelection()`, que solo repinta clases y muestras de las filas ya
montadas. `renderList()` se sigue usando cuando cambia *que* filas existen.
El timer no hacia falta: seleccionar y renombrar no compiten, el doble click
abre el input sobre la fila que el primer click acaba de seleccionar.

### Un solo camino de renombrado

Doble click y la tecla `N` entran los dos a `_startRename()`. Con varias
filas seleccionadas el nombre se aplica a todas y se ve mientras se tipea:
cada fila hermana muestra ya su numero final (`Ala 1`, `Ala 2`, `Ala 3`).
Enter confirma, Escape cancela sin tocar el estado. El input frena la
propagacion del teclado para que el keymap global no lea lo que se escribe.

### El nombre vive en el elemento, no en la pieza

`contour.name` existe tambien para contornos 2D y viaja a `piece.name` al
extruir: renombrar antes de extruir ya no se pierde. Al renombrar una pieza
se escribe en los dos lados, asi que borrar la pieza y volver a 2D conserva
el nombre. Ambos se serializan en `History.snapshot()`, que es la misma
serializacion que usa el `.inkora3d`, de modo que persisten en undo/redo y en
el archivo con un solo cambio.

### Paleta fija con nombre

`ColorPalette` define 14 colores con nombre en castellano. Son constantes del
programa, no estado del proyecto: aparecen iguales en cualquier archivo y no
se guardan. Conviven con "Colores del proyecto", que sigue mostrando lo que
ya se uso en la escena.

Una pieza cuyo nombre es automatico (`piece.nameAuto`) toma el nombre del
color al pintarse, numerado para no repetir: `Rojo 1`, `Rojo 2`. Un nombre
escrito a mano pone `nameAuto = false` y no se pisa nunca mas.

El renombrado ocurre solo al confirmar el color, no en la vista previa en
vivo: arrastrando por el cuadrado se pasa por cientos de valores y las piezas
quedarian renombrandose sin parar. Y el commit usa el hex textual de la
muestra (`exactHex`), no el reconstruido desde el estado HSV interno del
picker — ese ida y vuelta puede correr un digito y entonces el color deja de
coincidir con la paleta y no hay nombre que heredar.

### Nombres en la exportacion

Ya viajaban al 3MF (`<object name>` y `metadata key="name"`) y al OBJ (`g`).
Se agregan dos garantias en `buildExportRecords()`, comunes a los dos
formatos: los nombres repetidos se desambiguan (`Igual`, `Igual (2)`) porque
en OBJ dos `g` iguales se funden en un solo grupo, y en OBJ los espacios se
colapsan a `_` porque el espacio separa nombres de grupo — `Tapa frontal`
entraba como dos grupos y el nombre del elemento se perdia.

## 2026-08-03 (seguimiento 7) - Fuente canonica, librerias locales y distribucion obligatoria

### `index.html`

El fuente pasa de `inkora-3d-modeler-v10-corregido.html` a `index.html`.
Tener version y "corregido" en el nombre de un archivo es residuo de cuando
habia copias paralelas. Se eligio `index.html` y no `INKORA 3D Modeler.html`
porque el mismo archivo se sirve por HTTP: con `index.html` Vercel lo entrega
en `/` sin rewrite -- `vercel.json` se elimino -- y no hay espacios que
URL-encodear. El nombre con espacios se conserva solo en la copia externa,
que es para el usuario y no para una URL.

### Librerias locales

Las cinco librerias (three r128, SVGLoader, BufferGeometryUtils, Clipper,
JSZip) venian de `cdnjs` y `jsdelivr`. Una app de escritorio que no arranca
sin internet no es aceptable, y ademas ataba el arranque a que esos CDN no
movieran una URL. Ahora viven en `vendor/` y se cargan con ruta relativa, que
funciona igual desde `file://` en Electron y desde HTTP en Vercel.

Verificado bloqueando **toda** la red del renderer:

```text
peticiones de red bloqueadas: 1 (solo Google Fonts)
THREE, SVGLoader, BufferGeometryUtils, ClipperLib, JSZip: presentes
importa 17 contornos, extruye 1 pieza, exporta 3MF (88 KB) y OBJ (39 KB)
errores de consola: 0
```

Queda una sola dependencia externa: la tipografia de Google Fonts. Sin red
cae al tipo de letra de respaldo y no rompe nada, pero para ser 100% offline
habria que bajar los `woff2` y declarar `@font-face`.

El paquete incluye `vendor/` via `extraResources`, y `build-local-distribution.
ps1` la copia a la carpeta externa junto al HTML: sin esa carpeta al lado, la
copia externa abre en blanco.

### Regenerar la distribucion es parte de terminar

`distribute:local` ya hacia todo en un comando, pero no estaba escrito que
fuera obligatorio, y los `.exe` externos quedaron en `1.0.9` mientras el
codigo iba por `1.0.16`. Ahora `AGENTS.md` lo declara como paso de cierre de
tanda, con la tabla de que destino se actualiza por que via y la advertencia
de que `main.js` y `preload.js` solo llegan al portable y al instalador por
esta ruta.

No se pide correrlo en cada commit intermedio: empaqueta dos veces y corre la
regresion, son varios minutos.

Version HTML/Electron: `1.0.17`.

## 2026-08-03 (seguimiento 6) - El preload nunca cargaba en la app de escritorio

"Abrir en laminador" aparecia siempre deshabilitado dentro de la app, aun con
piezas 3D en escena. La causa no estaba en el boton: el preload entero fallaba
al cargar.

`preload.js` hacia `require('./package.json')` para leer la version. Desde
Electron 20 el renderer corre con `sandbox: true` por defecto, y ahi `require`
solo resuelve los modulos que provee Electron: requerir un archivo del disco
lanza y aborta el preload completo. Sin preload no existian `inkoraSlicer`,
`inkoraUpdater` ni `inkoraAppInfo`, asi que ademas **el auto-updater tampoco
funcionaba** y la version visible salia del fallback del HTML.

El sintoma aparecio recien ahora porque hasta `v1.0.12` el control estaba
oculto con `display:none` fuera de Electron; al hacerlo siempre visible quedo
a la vista que dentro de la app tampoco se habilitaba.

Se corrige sin bajar el sandbox: `main.js` pasa la version por
`additionalArguments` y el preload la lee de `process.argv`. Verificado con
las mismas `webPreferences` que usa la app real, sin `sandbox: false`:
`inkoraSlicer`, `inkoraUpdater` e `inkoraAppInfo` presentes y cero errores de
consola.

`main.js` usa `require('./package.json').version` y no `app.getVersion()`,
que cae a la version del runtime de Electron cuando no se ejecuta desde el
directorio empaquetado.

El acceso directo local apunta a `Proyecto\electron` con argumento `.`, asi
que toma `main.js` y `preload.js` del repo: alcanza con reabrir la app. Un
instalador ya generado necesita `npm run distribute:local`.

Version HTML/Electron: `1.0.16`.

## 2026-08-03 (seguimiento 5) - Resaltado por sub-cara en una pieza unida

Una pieza unida es un solo mesh con muchas sub-caras. `_applyHighlight()`
teñia el material entero, asi que señalar un detalle iluminaba los 116
contornos a la vez: no indicaba cual estaba elegido, lo tapaba.

El picking nunca estuvo mal — las 232 areas de sub-cara existian y
`pickBest()` ya elegia la mas chica. Lo que faltaba era mostrar el resultado.
Ahora cada area de picking lleva su propio material (antes compartian uno) y
la de la sub-cara elegida pasa a escribir color con el acento al 28%. La
pieza unida queda marcada con `_mergedPiece` y su resaltado global se
desactiva.

Medido sobre `Cataratas.dxf` unido, contando pixeles de acento en el
viewport:

| estado | pixeles de acento | areas encendidas |
| --- | ---: | ---: |
| sin seleccion | 0 | 0 |
| una sub-cara elegida | 114 | 1 |

El resaltado respeta las lineas de contorno porque usa exactamente la misma
forma que las dibuja: el `pickShape` de ese contorno.

### Contornos 2D que atravesaban las piezas

Los contornos aun no extruidos se dibujaban con `depthTest` desactivado para
no pelear con su propio relleno plano. Con piezas 3D en escena eso los
mostraba por encima de las paredes. Ahora la prueba de profundidad se activa
en cuanto hay al menos una pieza 3D; sin piezas, el comportamiento plano
queda igual.

Version HTML/Electron: `1.0.15`.

## 2026-08-03 (seguimiento 4) - Colores oscuros alcanzables y contornos que no traspasan

### No se podian elegir colores oscuros

Con luz de estudio, iluminacion por entorno y tone mapping ACES, la curva de
respuesta estaba aplastada contra el techo: `#101010` salia en pantalla como
`#7d8189` y `#220900` como un naranja claro. Bajar el cursor del selector no
servia: no habia forma de obtener una pieza oscura.

Se evaluo bajar las luces. Medido sobre una paleta de 11 colores, la mejor
combinacion de intensidad/entorno dejaba un error medio de 70 y hundia los
claros (`#ffffff` -> `#b8b9bd`): apaga toda la escena y no resuelve.

La solucion invierte la cadena en vez de debilitarla. `Viewport.
materialColorFor()` busca por biseccion el color de material cuyo render
coincide con el color elegido; la respuesta es monotona por canal, asi que
converge en pocos pasos. La escena conserva su iluminacion.

| elegido | antes | ahora |
| --- | ---: | ---: |
| `#331207` | 214 | 55 |
| `#8b2f10` | 225 | 42 |
| `#c8763c` | 177 | 9 |
| `#808080` | 178 | 2 |
| `#204080` | 231 | 5 |
| `#379836` | 236 | 13 |
| `#f0e6d0` | 36 | 1 |

Los extremos tienen un limite fisico de la escena, no del metodo: con la luz
ambiental el negro absoluto no baja de `#262d37` y el blanco no pasa de
`#f3f4f4`. En esos casos el material ya quedo en `#000000` o `#ffffff` y se
muestra lo mas cercano posible.

El color elegido no se toca: `piece.color` sigue siendo el hex real y es el
que se exporta al 3MF y al MTL. La compensacion afecta solo lo que se pinta.
Como consecuencia, la muestra del panel, el preview del picker y la paleta
vuelven a mostrar el hex elegido directamente: ya no hace falta traducirlo,
porque ahora la pieza se ve de ese color.

Medir es caro si la sonda hereda las sombras: clonar la luz del sol con su
`shadow.mapSize` de 2048 obliga a renderizar el shadow map en cada medicion.
La sonda clona las luces con `castShadow = false` — nada la ocluye — y las
11 mediciones pasan a costar 161 ms.

### Contorno seleccionado que se confundia con el resto

Desde `v1.0.12` la linea de contorno normal se elige por contraste contra la
pieza, asi que sobre una pieza oscura pasa a ser clara. El resaltado de
seleccion era blanco fijo: quedaba igual que el resto y dejaba de verse cual
sub-cara estaba elegida. Ahora el resaltado usa el color de acento del tema,
que se distingue tanto de una linea clara como de una oscura.

### Contornos que atravesaban las paredes

El contorno resaltado se dibujaba con `depthTest` desactivado para verse
siempre, pero eso lo hacia visible tambien por detras de la pieza y la
silueta se leia como si fuera transparente. Ahora respeta la profundidad.

Version HTML/Electron: `1.0.14`.

## 2026-08-03 (seguimiento 3) - Selector de color: gama sobre gris, paleta del proyecto y cuentagotas

### La gama no hacia nada sobre una pieza blanca

No era un problema de sincronizacion del deslizante: con saturacion 0,
`hsvToHex()` devuelve el mismo gris para cualquier angulo. El color por
defecto de una pieza es blanco, asi que arrastrar la gama daba exactamente
`#ffffff` una y otra vez. Medido: mover la gama al 50% sobre `#ffffff`
dejaba `#ffffff`; recien al tocar el cuadrado aparecia el color.

Al tocar la gama se asume que se quiere un color, asi que se sale de la
linea de grises lo minimo necesario (`s = 1` si `s < 0.05`, `v = 0.9` si
`v < 0.1`). Con eso, la gama al 50% sobre blanco da `#00ffff`.

### El preview mostraba otra referencia que el resto

Desde `v1.0.12` la muestra del panel y la pieza usan el color visible. El
preview del picker seguia mostrando el hex crudo, asi que quedaban dos
referencias distintas para el mismo color. Ahora el preview tambien muestra
el color visible y el codigo real se lee al lado, sobre el propio preview,
con contraste calculado. El color que se exporta sigue siendo el hex crudo.

### Paleta del proyecto y cuentagotas

- Debajo del preview aparecen los colores unicos ya usados por alguna pieza.
  Se pintan con el color visible y muestran el codigo real al pasar el
  mouse, sin cambiar todavia la pieza; al hacer click se aplica y se cierra.
  La lista se reconstruye solo cuando cambia su firma, para no rearmar el
  DOM en cada movimiento del cursor sobre el cuadrado.
- El cuentagotas usa la API `EyeDropper` del navegador, asi que toma color
  de cualquier parte de la pantalla y no solo del viewport. Donde no exista,
  el boton queda deshabilitado con el motivo en el tooltip en vez de fallar
  al hacer click.

Version HTML/Electron: `1.0.13`.

## 2026-08-03 (seguimiento 2) - Color visible, contraste de contorno y controles de la barra

### El swatch mostraba el hex crudo, no el color que se ve

Entre el color de un material y el pixel en pantalla hay tres etapas: las
luces (incluida la iluminacion por entorno de `buildStudioEnvironment`), el
tone mapping ACES y la codificacion sRGB de salida. El panel pintaba el hex
crudo, asi que la muestra se veia mucho mas oscura que la pieza.

No se replico esa cadena con una formula: con IBL y ACES cualquier formula
queda desactualizada apenas cambien las luces. Se **mide**. `Viewport.
shadedColor()` renderiza un fragmento de superficie con el mismo renderer,
el mismo entorno, las mismas luces y el mismo material, y lee el pixel. La
sonda mira desde la misma direccion que la camara por defecto: medir en
picado daba un color ~17% mas claro, porque con `roughness 0.55` el angulo
de vista cambia el brillo. El resultado se cachea por color.

Distancia euclidea entre la muestra del panel y el pixel real de la pieza:

| color | antes | ahora |
| --- | ---: | ---: |
| `#c8763c` | 177 | 19 |
| `#8b2f10` | 213 | 13 |
| `#204080` | 215 | 17 |
| `#f0e6d0` | 24 | 21 |

El residuo es la orientacion exacta de la cara y la posicion de camara del
momento. El color que se exporta al 3MF y al MTL sigue siendo el hex crudo:
lo medido es solo para mostrar.

### Contorno con contraste dinamico

Las lineas de contorno de una pieza 3D estaban fijas en `0x222222`. Pero no
compiten contra el fondo del viewport sino contra la propia pieza, que puede
tener cualquier color. `Utils.contrastingLineColor()` elige claro u oscuro
por luminancia del color **visible** (no del hex crudo), y se reevalua al
extruir, al refrescar la seleccion y al cambiar el color de una pieza. Una
pieza negra pasa a `#262d37` visible y recibe linea clara; el resto de la
paleta se ve claro con esta iluminacion y recibe linea oscura.

### Controles de la barra

- **Separacion al exportar**: el interruptor y el campo de mm eran dos
  controles pegados. Ahora son uno solo: el borde vive en el contenedor, el
  icono alterna y el valor se edita en el lugar. Apagado se atenua entero
  pero el valor sigue visible, porque es el que se va a usar al encenderlo.
- **Abrir en laminador**: estaba oculto con `display:none` fuera de Electron,
  asi que en el HTML suelto o en la web la funcion parecia no existir. Ahora
  se muestra siempre, deshabilitado y con el motivo en el tooltip. Lanzar una
  aplicacion instalada sigue siendo posible solo desde la app de escritorio.

Version HTML/Electron: `1.0.12`.

## 2026-08-03 (seguimiento) - Exportacion OBJ, presets de exportacion y seleccion tras extruir

### Por que OBJ

OrcaSlicer no toma los colores del 3MF que genera INKORA, pero si los toma
del mismo modelo en OBJ (verificado a mano por el usuario). El OBJ deja de
ser un formato "extra" y pasa a ser la via para llevar el modelo multicolor
a Orca.

### Corte entre geometria y serializacion

`generate3MFBlob()` mezclaba dos etapas. Se separo en:

```text
buildExportRecords()   <- solido canonico, contrato manifold, holgura, piso
generate3MFBlob() / generateOBJFiles()   <- un serializador por formato
```

Un serializador nunca construye su propia geometria. Un fallo antes del
corte afecta a los dos formatos; uno despues pertenece a un solo formato y
se corrige sin tocar el otro. El orden de colores unicos sale de la etapa
comun, asi que una pieza cae en el mismo filamento en 3MF y en OBJ.

### Decisiones del formato OBJ

- **Dos archivos, sin zip.** Por pedido explicito: `.obj` y `.mtl` se
  descargan seguidos dentro del mismo gesto del usuario. Separarlos con un
  timer haria que la segunda descarga pierda el gesto y Chrome la trate como
  descarga automatica. En Electron no hay limite; en navegador Chrome puede
  pedir permiso una vez por sitio.
- **Indices globales y 1-based.** No por objeto como en 3MF: cada pieza
  acumula el offset de las anteriores. Es el error clasico del formato y
  tiene su propia verificacion en la regresion.
- **`g` y no `o`.** Con `g` el laminador toma el archivo como un modelo con
  grupos de material; con `o` cada pieza entra como objeto suelto en la
  placa. Es la estructura que traen los OBJ que Orca ya interpreta bien.
- **Un material por color unico**, en el mismo orden que el colorgroup del
  3MF.

### Presets de exportacion

Los botones Exportar y Abrir en laminador pasan a ser botones partidos: el
cuerpo ejecuta, la flecha elige. Antes, el boton de laminador abria el panel
y elegir un laminador abria la aplicacion en el acto; ahora elegir solo
guarda el preset.

Formato y laminador son preferencias del usuario, no estado del documento:
viven en `localStorage` (`inkora3d-export-format`, `inkora3d-slicer`), no
entran en el snapshot de historial ni en el proyecto guardado, y sobreviven
a cerrar el programa. Defaults `3mf` y `bambu`. Un valor guardado que ya no
exista cae al default en vez de dejar la interfaz en un estado que no se
puede corregir desde la interfaz.

Los dos presets se combinan: OBJ + Orca abre el OBJ en Orca. `Ctrl+E`
exporta en el formato elegido; `Ctrl+Shift+O` abre en el laminador elegido.

`main.js` escribia el temporal con extension `.3mf` fija. Ahora acepta un
conjunto de archivos que se escriben juntos en un subdirectorio propio con
los nombres tal cual los genero el HTML, y abre el marcado con `open: true`.
El `.mtl` tiene que quedar al lado del `.obj` con el nombre exacto que
declara `mtllib` o el laminador abre el modelo gris. Esto vive en el paquete
Electron: **no alcanza con actualizar el HTML, hay que regenerar el .exe**.

### Seleccion despues de extruir

Extruir dejaba la seleccion vacia. Ahora deja seleccionada la extrusion
recien creada: una pieza en modo unido, todas las nuevas en modo separado.
Se resuelve por identidad de pieza y no por rango de indices, porque una
pieza 3D agrega su propio contorno ficticio al final mientras que una 2D
reusa el de origen. Se aplica antes del snapshot para que UNDO/REDO la
restauren igual.

Eso convierte "extruir dos veces seguidas" en un flujo normal y destapo que
la re-extrusion 3D no tenia el guard de material que si tiene la 2D: con
todo seleccionado, una cara cuyos huecos la cubren entera dejaba la union 2D
vacia. En `HEAD` eso no daba error, colgaba la aplicacion (se aborto la
medicion a los 20 minutos). Ahora esa cara se descarta y se informa.

### Re-extrusion: el guard faltaba en el camino 3D

La causa no era el solido canonico sino que `addFaceTopology()` y el
respaldo por `_holeIdxs` agregaban huecos sin el chequeo `enclosesInterior()`
que si tenia `absorbChildren()`. Con un anillo hijo coincidente (contorno 14
del Tucan, gemelo exacto del 0) la cara quedaba sin material y la
re-extrusion abortaba entera.

Con el guard en los tres puntos:

| | antes | ahora |
| --- | ---: | ---: |
| Re-extruir pieza unida | abortaba | 1 pieza, UNDO correcto |
| Re-extruir 16 piezas separadas | 0 (colgaba en `HEAD`) | 16 |

### Queda abierto

Re-extruir las 16 piezas separadas del Tucan crea las 16 pero despues lanza
`La union 2D produjo una pieza vacia`, y el `throw` corta el handler antes
de `History.push`: las piezas quedan en escena sin snapshot y el siguiente
UNDO salta al estado importado en vez de al anterior. El chequeo de area que
descarta caras sin material es aritmetico (`outer - suma de huecos`) y no
cubre huecos que se solapan entre si o exceden el contorno; para eso hace
falta medir el area resultante con Clipper. Independiente de eso, una pieza
que falla no deberia abortar el lote entero.

### Regresion

`objTucan` y `objLayered` validan lo exclusivo del formato: indices en rango
y 1-based, cantidad de vertices declarada, un grupo por pieza, cierre de
malla por grupo, `mtllib` coincidente con el nombre real del `.mtl`,
materiales usados declarados y sin sobrantes, y paridad de colores con el
3MF. El cierre se mide por grupo: piezas adyacentes comparten frontera
exacta por invariante del pipeline, asi que soldar todo el archivo junto
reportaria aristas de cuatro caras que no son un defecto. Version
HTML/Electron: `1.0.11`.

## 2026-08-03 - Diseno por capas denso: colores ACI, vacios falsos, union unida y marquee

Reportado sobre `Modelos/Cataratas.dxf` / `.svg` (5 colores, ~130 regiones,
un solo hueco real: la argolla).

### Causa raiz comun: la tabla ACI estaba incompleta

`aciToHex()` solo conocia ~26 indices (1-9, algunos multiplos de 20, 250-255).
Cataratas usa 7, 28, 97 y 134: tres de los cuatro caian a `null`, se resolvian
por color de capa y **todas** las entidades terminaban en `#ffffff`.

Como `dxfPaintStyleKey()` es `layer|color`, eso dejaba las 79 entidades en una
sola tirada de estilo. `buildDXFMaterialItems()` armo entonces un unico objeto
compuesto con 69 anillos y, por paridad, marco 44 piezas internas como vacio.
Un vacio no es seleccionable ni listable (v1.0.9, seccion 12 del pipeline): de
ahi que "seleccionar todo" dejara huecos y que tampoco se pudieran seleccionar
a mano. El SVG no sufria nada porque trae `fill-rule` y clases CSS reales.

Medicion antes/despues, mismo archivo:

| | contornos | vacios | seleccionables | colores |
| --- | ---: | ---: | ---: | ---: |
| DXF antes | 120 | 45 | 75 | 1 |
| DXF ahora | 119 | 1 | 118 | 4 |
| SVG | 134 | 1 | 133 | 4 |

Fix: generar la paleta ACI `10..249` completa con el modelo documentado de
AutoCAD (24 tonos x 10 niveles) y conservar explicitos `1..9` y `250..255`.
No se toco la inferencia de compuestos: con colores correctos ya distingue
bien los objetos.

### Extrusion unida: 80 s o crash -> menos de 1 s

`Solid2D.unionShapes()` acumulaba linealmente: un `Execute` de Clipper por
shape, cada uno reprocesando todo el acumulado. Con 133 contornos eso es
`O(N * M)`. Medido: 80.023 ms de los 80.337 ms totales de la extrusion.
En el DXF (con los 45 vacios falsos) directamente abortaba a los 260 s con
`No se pudo regularizar el contacto puntual del hueco`.

Fix: union por pares en arbol, con las hojas ordenadas espacialmente. Cada
`Execute` sigue viendo dos regiones ya consolidadas — nunca una carga masiva
de contornos crudos, que era el motivo real de no hacer la union de golpe —
pero el resultado parcial se reprocesa `log2(N)` veces en vez de `N`.

| | antes | ahora |
| --- | ---: | ---: |
| Cataratas SVG unido | 88.159 ms | 464 ms |
| Cataratas DXF unido | aborta a los 260 s | 234 ms |
| Tucan DXF/SVG unido | igual malla | igual malla |

### Marquee: caja del mundo en vez de silueta proyectada

El rectangulo probaba "100% adentro" contra las ocho esquinas de un `Box3`
del mundo. Es un envolvente alineado a los ejes del modelo: para una forma
diagonal, curva o vista en perspectiva sobresale de la silueta dibujada y
descarta piezas que el usuario ve completamente cubiertas. Ahora se proyectan
los vertices reales de la geometria del propio mesh (los hijos de una pieza
son decorativos o de picking). Ademas, un marquee vacio deselecciona y
refresca el panel en vez de salir dejando el badge anterior.

### Pegar un archivo DXF/SVG desde el portapapeles

`Ctrl+C` sobre el archivo en el explorador y `Ctrl+V` en la app: el archivo
llega en `clipboardData.files`, no como texto. Se resuelve con el mismo
`loadDXF()` del boton Importar, asi conserva el encoding latin1 del DXF y el
nombre del archivo como nombre de proyecto. El pegado de texto DXF/SVG (macro
de Corel) sigue igual.

### Tres defectos previos que bloqueaban "seleccionar todo y extruir"

Aparecieron al quedar habilitado el flujo completo. Los tres estaban desde
antes de estos cambios (verificado corriendo el HTML de `HEAD`):

1. **Anillo hijo coincidente tratado como hueco.** En el Tucan DXF, el
   contorno 14 es el gemelo exacto del 0 con winding opuesto. Restarlo dejaba
   la pieza sin material y la extrusion entera abortaba con cero piezas.
   `enclosesInterior()` exige ahora que el hijo sea estrictamente mas chico.
   Tucan DXF separado: 0 piezas -> 16. Tucan SVG separado: 2 -> 18.
2. **Contorno cubierto por sus hijos seleccionados.** Con "seleccionar todo",
   los hijos pueden tapar exactamente todo el interior del padre. Eso no es un
   error: el padre no aporta material propio. Se descarta e informa en el
   toast, en vez de lanzar. Cataratas DXF separado: 5 piezas -> 116.
3. **Umbral de triangulo degenerado demasiado alto.** `cleanMeshTriangles()`
   descartaba triangulos con `area2 < 1e-12`, o sea area menor a `5e-7 mm2`.
   La grilla canonica de Clipper es de `1e-4 mm`, asi que borraba caras finas
   legitimas y abria la malla: el 3MF unido de Cataratas SVG fallaba con 38
   aristas abiertas (tambien en `HEAD`). Baja a `1e-24`, que solo cubre el
   colineal exacto. Export unido: falla -> 457 KB validos.

### Queda abierto

En modo separado, el contorno base de Cataratas DXF se extruye con ~60 huecos
seleccionados y produce una malla con aristas compartidas por mas de dos caras
(798) ademas de abiertas (40). El 3MF de esa pieza no exporta. Es anterior a
estos cambios y no se resolvio; la regresion exige el contrato 3MF sobre el
solido canonico del modo unido y deja el caso separado documentado en vez de
congelarlo como correcto.

### Regresion

`electron/tests/geometry-regression.js` incorpora `Cataratas.dxf` y
`Cataratas.svg` como fixture de diseno por capas: paridad de vacios entre
formatos, contornos seleccionables, colores conservados, "seleccionar todo +
extruir" en ambos modos con presupuesto de tiempo, y contrato 3MF en modo
unido. El resto de la suite (incluido el laminado real en Bambu Studio) sigue
en verde. Version HTML/Electron: `1.0.10`.

## 2026-08-02 - Distribucion local estandarizada

El proyecto adopta de forma explicita el estandar optativo de
`INKORA Workspace\LOCAL_APP_STRUCTURE.md`. La carpeta externa queda como
presentacion local y contiene `Proyecto/`, instalador, portable, HTML externo y
acceso directo.

El repositorio completo vive en `Proyecto/`. La distribucion se regenera desde
`Proyecto\electron` con:

```powershell
npm.cmd run distribute:local
```

El script ejecuta la regresion geometrica, crea instalador NSIS y portable con
Electron Builder, publica ambos `.exe` con nombres estables en la carpeta
externa y regenera el acceso directo con `electron\build\icon.ico`.

El acceso directo apunta al runtime local de Electron dentro de
`Proyecto\electron`, con argumentos para abrir el proyecto vivo. El portable
queda como artefacto externo separado.

Por pedido explicito del usuario, el script tambien publica
`INKORA 3D Modeler.html` junto al portable y al instalador. Es una copia estable
del HTML vivo del repo para abrir desde navegador.

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

## 2026-07-25 -- SVG/DXF/Corel: resolver solapes visuales antes de extruir

### Sintoma observado

En un diseno tipo tucan, al seleccionar visualmente solo una parte del pico
y extruir, aparece una pieza mucho mas grande de lo esperado: se extruyen
zonas de la base negra y quedan paredes finas en limites donde, en CorelDRAW,
otra pieza coloreada esta perfectamente apilada encima.

El problema se reprodujo importando SVG y DXF, asi que no corresponde al
ultimo fix de absorcion de huecos (`e5bd6f1`) ni es especifico de Electron.
El mismo DXF extruido en Fusion 360 no genera paredes finas, lo cual confirma
que el archivo fuente es usable y que el problema esta en nuestro modelo de
importacion: la app interpretaba la geometria vectorial completa de cada
shape, no el resultado visual final despues de apilar capas/formas.

### Estado anterior documentado para rollback

Estado vigente antes de esta implementacion:

- `SVGParser.loadText()` usa `THREE.SVGLoader.parse()` y
  `THREE.SVGLoader.createShapes(path)`.
- Cada shape exterior y cada hole del SVG se aplana como contorno
  independiente en `flat`.
- `DXFParser.loadText()` generaba sus shapes desde `ENTITIES`, los deduplicaba
  y pasaba directo a `computeHierarchy(shapes)`, sin resolver areas ocultas por
  entidades dibujadas encima.
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

### Solucion aplicada

Se agrego una etapa de preprocesamiento antes de `computeHierarchy`: resolver
la geometria visible por orden de pintado usando booleanos 2D. Empezo para
SVG/Corel y ahora se aplica tambien al DXF de Corel, porque los fixtures reales
en `Modelos/Tucan.dxf` preservan un orden de entidades compatible con el
apilado visual.

Algoritmo aplicado para SVG y DXF:

1. Parsear y aplanar los fills/entidades en orden de documento/pintado,
   conservando `layer`, `color` y un `elementId` por operacion de pintado.
2. Convertir cada fill a poligono booleano robusto, incluyendo sus holes.
3. Procesar de arriba hacia abajo manteniendo `coveredAbove`, la union de todo
   lo que ya fue pintado encima.
4. Para cada shape: `visible = paintedShape - coveredAbove`.
   `coveredAbove` se expande solo 0.04 mm durante la resta para absorber
   diferencias submilimetricas entre curvas casi coincidentes, que eran las
   paredes finas visibles.
5. Si `visible` queda vacio o menor a un umbral de area, descartarlo.
6. Si `visible` se divide en varias islas, emitir cada isla como componente
   seleccionable separado.
7. Si una isla visible tiene holes reales, emitir exterior + holes con el
   mismo `elementId:part:N`; una isla desconectada recibe otro `part:N`, para
   que la extrusion no vuelva a unir regiones separadas por una capa superior.
8. Recalcular `parentIdx`/`depth` sobre los contornos visibles resultantes y
   continuar con el pipeline actual (`populateShapeData`, seleccion,
   extrusion, historial y exportacion).

La solucion vive en importacion, no en extrusion. El boton Extruir debe
seguir trabajando con contornos ya limpios/visibles; asi el mismo arreglo sirve
para exportar 3MF, abrir en laminador, guardar proyecto y reextruir.

Implementacion:

- Nuevo script CDN: `clipper-lib@6.4.2/clipper.js`.
- Nuevo modulo aislado: `SVGVisibleGeometry` (nombre heredado; ahora es el
  resolver visible compartido por SVG y DXF).
- `SVGVisibleGeometry.resolve(items)` procesa de arriba hacia abajo,
  mantiene `coveredAbove`, calcula `visible = painted - coveredAbove` y
  devuelve contornos planos en el orden original de pintado.
- Cada resultado visible calcula una jerarquia local: exteriores y sus holes
  comparten `elementId:part:N`, pero islas desconectadas reciben otra identidad.
- `DXFParser.loadText()` transforma cada shape DXF en un paint item, conserva
  `layer`, `color` y `elementId`, y recien despues recalcula jerarquia sobre
  los contornos visibles resultantes.
- Si Clipper no carga, hay fallback al comportamiento anterior: importar los
  contornos SVG/DXF sin resolver solapes visuales, con warning en consola. La
  app no queda rota por una falla de CDN.

### Alcance recomendado

Implementacion aplicada a SVG/Corel y DXF/Corel. DXF no siempre preserva un
orden de dibujo confiable en todos los CAD, pero el fixture real de Corel tiene
13 `LWPOLYLINE` cerradas con orden/capa/color consistente, y Fusion 360 extruye
ese mismo DXF sin generar paredes finas.

La implementacion quedo aislada detras de `SVGVisibleGeometry.resolve(items)`,
para que sea facil desactivarla o revertirla sin tocar la extrusion.

### Que NO conviene hacer

- No corregir esto con offsets grandes o manuales durante la extrusion:
  esconderia paredes pero cambiaria dimensiones reales. La unica tolerancia
  aceptada aqui es una expansion minima de cobertura en el booleano 2D
  (`0.04 mm`) para eliminar residuos de curvas casi coincidentes antes de crear
  `State.contours`.
- No intentar deducirlo desde el click/seleccion: ahi ya se perdio el orden
  visual y la forma inferior ya entro completa.
- No hacer booleanos directamente en 3D: es mas caro, mas fragil y llegaria
  tarde. El problema es 2D y debe resolverse antes de crear `State.contours`.

### Verificacion esperada con archivos reales

- SVG minimo: rectangulo negro abajo + rectangulo naranja encima. Al importar,
  el negro visible debe quedar recortado; extruir naranja no debe generar pared
  negra debajo.
- SVG tipo tucan: el pico naranja/gris/blanco debe quedar separado segun lo
  visible en Corel; seleccionar una parte debe extruir solo esa region.
- DXF tipo tucan exportado desde Corel: la base no debe quedar como una region
  completa escondida debajo del pico, alas, patas y ojo; al seleccionar una
  cara visible, no deben extruirse paredes finas por debajo de piezas
  superiores.
- Letras o formas con holes reales del mismo path deben seguir extruyendo con
  huecos correctos.
- Formas donde una capa superior divide una inferior en varias islas deben
  aparecer como contornos separados.
- Proyectos `.inkora3d` viejos deben cargar igual que antes, porque ya guardan
  contornos resueltos y no pasan de nuevo por el importador.

### Verificacion realizada

- Sintaxis de los scripts inline del HTML validada con `vm.Script`.
- `git diff --check` sin errores.
- `clipper-lib@6.4.2/clipper.js` verificado contra jsDelivr: respuesta HTTP
  200.
- Prueba de modulo real extraido del HTML: rectangulo inferior `0..10`
  recortado por rectangulo superior `4..10` devuelve el inferior visible
  `0..4` y el superior intacto.
- Prueba de modulo real extraido del HTML con capa superior con hole: el
  inferior devuelve exterior + hole + isla interna, y el superior devuelve
  exterior + hole; es la estructura que `computeHierarchy` y `btn-extrude`
  ya manejan como huecos/islas.
- Prueba con `Modelos/Tucan.dxf`: 13 `LWPOLYLINE` cerradas pasan por el mismo
  resolver visible. La base, que antes entraba completa con area aproximada
  `1006.724 mm2`, queda recortada en perfiles visibles; el primer perfil
  resuelto queda en `431.504 mm2`, lo que confirma que las zonas tapadas por
  capas superiores ya no llegan intactas al extrusor.
- En esa misma prueba, la base queda separada en componentes visibles
  `dxf:0:part:0` y `dxf:0:part:1`; los holes permanecen con el componente
  exterior correcto, pero la isla desconectada ya no comparte identidad de
  extrusion automatica con el resto de la base.

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

## 2026-07-25 -- Version visible en HTML/Web/Electron

Para evitar dudas al reiniciar o abrir otra instalacion, la app muestra una
version visible y sutil junto al logo del header.

Regla:

- La version actual de esta tanda es `v1.0.2`.
- En web/HTML, `APP_VERSION` usa el fallback fijo `1.0.2` y sincroniza el
  badge, `document.title` y el meta `inkora-version`.
- En Electron, `preload.js` expone `window.inkoraAppInfo.version` desde
  `electron/package.json`; el HTML usa ese valor para mostrar la version real
  instalada.
- `electron/package.json` y `electron/package-lock.json` deben avanzar juntos.
- La metadata `Application` de los 3MF exportados usa `APP_VERSION`, y los
  proyectos `.inkora3d` nuevos guardan `appVersion`.

Verificacion realizada:

- Sintaxis de scripts inline del HTML validada con `vm.Script`.
- `node --check electron/main.js` y `node --check electron/preload.js`.
- `npm.cmd pkg get version` en `electron/` devuelve `1.0.2`.

## 2026-07-25 (seguimiento del fix de solapes) — El DXF perdía huecos reales (pupila del ojo, agujero del llavero)

### Síntoma

Con el fix de solapes visuales (`9069da5`) ya funcionando para las paredes
finas, quedó un problema distinto: al importar `Modelos/Tucan.dxf`, dos
huecos reales del diseño (la pupila del ojo y el agujero del aro del
llavero) no aparecían — ni en el import 2D ni al extruir. El mismo diseño
exportado a SVG (`Modelos/Tucan.svg`) sí los traía bien.

### Dos intentos descartados antes de encontrar la causa real

1. **Agrupar por contención geométrica antes del resolver** (un punto de
   prueba: "¿este contorno cae adentro de otro?"). Rompió la extrusión:
   el ala/pico quedaron cortados como si fueran huecos del cuerpo. Un
   punto de prueba no distingue "hueco real" de "pieza sólida separada
   que se superpone".
2. **Lo mismo pero verificando el área real de superposición con Clipper**
   (no un punto, el % de área contenida). También rompió — midiendo la
   superposición real se confirmó que el cuerpo contiene ~100% del área
   de *todas* las demás piezas (ala, pico, patas), no solo de los huecos
   reales. Causa: la pieza de "cuerpo" en este diseño es la fusión de
   *todas* las piezas del llavero puesta como fondo — geométricamente es
   indistinguible de un hueco genuino con 100% de contención. La
   geometría sola no alcanza para esta distinción.

### Causa raíz real

`SVGVisibleGeometry.resolve()` asume que el orden del archivo es el orden
de pintado ("lo de después tapa a lo de antes"). Correcto para piezas
sólidas independientes que se superponen: cuando el ala se dibuja después
del cuerpo, el ala sobrevive con su propia área y el cuerpo pierde solo la
parte tapada — el ala nunca desaparece del todo. Pero el agujero del
llavero está dibujado en Corel **antes** que su aro exterior. Como el
resolver no sabe que ese anillo es un hueco intencional, cuando llega el
turno de procesar el aro (dibujado después = "tapa" según el algoritmo),
el agujero queda cubierto por completo y su área visible cae a cero — se
pierde sin dejar rastro, y el aro se resuelve como disco sólido en vez de
como anillo.

Confirmado extrayendo las 13 `LWPOLYLINE` del DXF directamente (no con
`grep`, con un parser real de codigo+valor) y midiendo con Clipper cuánto
del área de cada una queda contenida en las demás: la pupila (1.34×1.39mm)
y el agujero del llavero (4×4mm, dentro del aro de 8×7.65mm) son,
confirmado empíricamente, las **únicas** dos piezas cuya área visible cae
a cero al correr el resolver original — ninguna pieza sólida legítima
(ala, pico, patas) llega nunca a cero, porque todas están dibujadas
*después* de la pieza de fondo, nunca antes.

### Solución: usar "¿desaparece del todo?" como señal, no la geometría sola

`DXFParser.buildDXFPaintItems(shapes)`:

1. Arma los paint items originales (un anillo por entidad, sin agrupar) y
   corre `SVGVisibleGeometry.resolve()` una vez tal cual — un "dry run".
2. Compara los `elementId` base de la salida contra los de entrada: toda
   entidad cuyo `elementId` no sobrevive con ningún resultado quedó con
   área visible cero ("desapareció").
3. **Solo** para esas entidades desaparecidas, busca su contenedor real
   (el más chico que la contiene en ≥97% de área, vía
   `SVGVisibleGeometry.overlapFraction`, nueva función expuesta que mide
   intersección real con Clipper en vez de un punto de prueba) y la
   agrega como anillo extra de ese contenedor.
4. Vuelve a armar los paint items con esa corrección puntual y corre
   `resolve()` de nuevo — recién ahí se usa el resultado final.

Ninguna pieza que sobrevive el `resolve()` original se toca: el ala, el
pico y las patas pasan exactamente por el mismo camino que antes de este
fix. Solo se corrigen las entidades que el algoritmo original pierde por
completo — que es justamente el síntoma reportado, ni más ni menos.

### Por qué no unificar SVG y DXF convirtiendo uno al otro

Se evaluó la idea de tratar SVG como formato interno único y convertir
DXF a SVG antes de importar. Se descartó: para emitir un SVG-con-huecos
válido desde el DXF, igual hace falta primero determinar qué polilínea es
hueco de cuál — exactamente el mismo trabajo geométrico que este fix ya
hace. Convertir no ahorra nada, solo reubica el problema y agrega una
capa de serialización/re-parseo de más.

### Verificación

Con Chrome DevTools MCP, importando `Modelos/Tucan.dxf` (subido con
`upload_file`, no simulado):

| | Antes del fix | Después del fix |
|---|---|---|
| Contornos totales | 13 | 16 |
| Pupila del ojo (~1.3×1.3mm) | ausente | presente, hueco de la pieza del ojo |
| Agujero del llavero (4×4mm) | ausente (aro sólido) | presente, hueco del aro (8×7.65mm) |
| Color del ala/pico/patas | preservado | preservado, sin cambios |
| Extrusión "Objetos separados" | silueta completa, sin fragmentar | silueta completa, sin fragmentar |
| Extrusión "Objeto unido" | silueta completa | silueta completa |

Sin errores de consola en ningún caso. Sintaxis del archivo completo
validada con `node --check`. El caso SVG no se tocó (ningún cambio en
`SVGParser` ni en `SVGVisibleGeometry.resolve()`, solo se le agregó la
función `overlapFraction`, aditiva).

## 2026-07-25 (seguimiento) — Tres bugs relacionados con piezas anidadas (ojo/pupila)

Reportados juntos usando el caso del ojo del tucán (anillo exterior +
pupila interior), probando en el navegador antes de tocar nada.

### 1. Re-extrusión de una cara con una pieza interior ya extruida la duplicaba

**Síntoma:** extruir el anillo del ojo, extruir la pupila por separado
(funciona bien, igual que siempre) — pero volver a extruir la cara
superior del anillo (re-extrusión) convertía el anillo en un cilindro
sólido sin hueco, como si la pupila nunca hubiera existido.

**Causa:** `absorbChildren` (primera extrusión) y `addFaceTopology`
(re-extrusión) hacen básicamente lo mismo — recorrer huecos/islas de un
contorno para armar el `compositeShape` — pero `absorbChildren` chequea
`if (candidate.extruded) return` / `if (island.extruded) return` antes de
absorber algo, y `addFaceTopology` no tenía ningún chequeo equivalente.
Al re-extruir, volvía a "absorber" la pupila como si fuera una isla nueva
sin pieza propia, duplicándola dentro del composite del anillo — aunque
ya tenía su propia pieza 3D independiente.

**Fix:** un chequeo (`if (island.piece) return;`) en el loop de islas de
`addFaceTopology`, mismo criterio que ya usaba `absorbChildren` (no
duplicar algo que ya tiene su propia pieza), pero sin tocar el hueco en
sí — el hueco (`hole`) sigue agregándose siempre, porque ese sí necesita
recortarse de nuevo en cada re-extrusión.

### 2. Hover en contornos 2D (sin extruir) no hacía nada — `ReferenceError` silencioso

**Síntoma:** pasar el mouse sobre un contorno 2D sin extruir no mostraba
ningún resalte suave.

**Causa:** al recalibrar el highlight adaptativo de piezas 3D (entrada
anterior de este mismo día), se renombraron las constantes
`HIGHLIGHT_MIX_HOVER`/`HIGHLIGHT_MIX_SELECT` a
`HIGHLIGHT_DARKEN_*`/`HIGHLIGHT_GLOW_*` — pero la rama 2D de
`setHoverVisual` (una implementación separada, para `MeshBasicMaterial`
sin luces, que nunca tuvo el problema de tonemapping) seguía referenciando
el nombre viejo `HIGHLIGHT_MIX_HOVER`, que ya no existía. Cada hover sobre
un contorno 2D tiraba un `ReferenceError` dentro del handler de
`mousemove` — silencioso para el usuario (no rompe la página, solo aborta
ese frame de highlight) pero con el efecto observado de "no pasa nada".

**Fix:** se restauró la constante con nombre propio,
`HIGHLIGHT_MIX_HOVER_2D = 0.22` (el valor correcto para este caso, ya
confirmado en la entrada anterior — 2D no sufre el problema de
tonemapping de las piezas 3D).

### 3. El resaltado de selección 2D desaparecía al sacar el mouse (aunque siguiera seleccionado)

**Síntoma:** seleccionar un contorno 2D resalta fuerte (bien) — pero al
sacar el mouse de encima, el resaltado desaparecía por completo, aunque
el contorno seguía seleccionado.

**Causa:** la rama 2D de `setHoverVisual`, al terminar el hover,
restauraba un *snapshot* de color/opacidad capturado al EMPEZAR el hover
(`_hoverOrigColor`/`_hoverOrigOpacity`). Si la selección cambiaba
*mientras* el mouse seguía encima (flujo normal: pasar el mouse, ya
resaltado suave, hacer click para seleccionar) ese snapshot quedaba
desactualizado — capturado ANTES del click, con la apariencia
"sin seleccionar" (opacity 0). Al sacar el mouse después, se restauraba
ese snapshot viejo en vez del estado real, apagando el resaltado de
selección.

**Fix:** en vez de restaurar un snapshot cacheado, la rama de "hover
termina" ahora llama a `PanelUI.refreshContourVisuals()` — la única
fuente de verdad de "cómo se ve este contorno ahora" (seleccionado o no).
Elimina la necesidad de rastrear un snapshot para el caso de apagado.

### 4. El resaltado de selección se "salía" del contorno real (bleed hacia piezas internas)

**Síntoma:** seleccionar un contorno grande (ej. la cabeza) pinta su
relleno sobre toda el área geométrica, incluida la zona donde hay otros
contornos dibujados encima (ojo, pupila) — se ve como si esas piezas
internas también estuvieran resaltadas.

**Causa:** `GeoModule.makeFlat` construye la geometría del mesh 2D
(`flatMesh`, el que recibe el relleno de hover/selección) directamente
del `shape` importado, sin huecos — a diferencia de la extrusión, que sí
arma un `compositeShape` con huecos reales (`absorbChildren`), el mesh de
DISPLAY nunca tuvo ese tratamiento.

**Fix:** `makeFlat` ahora acepta un array opcional de huecos
(`holeShapes`); si se pasa, clona el shape (para no mutar el original,
que se sigue usando tal cual para jerarquía y extrusión) y le agrega esos
huecos antes de construir la geometría. `populateShapeData` (el import de
DXF/SVG) calcula los huecos DIRECTOS de cada contorno (mismo criterio de
un nivel que usa `absorbChildren`: hijos con `depth+1`, no toda la
descendencia) antes del loop de creación, y se los pasa a `makeFlat`.

**Alcance:** solo se tocó el import inicial (`populateShapeData`). El
otro sitio que construye `flatMesh` (restaurar un proyecto guardado,
`inkora3d`/`.json`) no se tocó — queda pendiente si hace falta el mismo
tratamiento ahí.

### Verificación

Con Chrome DevTools MCP, reproduciendo el caso del ojo (anillo idx12 +
pupila idx8) paso a paso:

- Re-extrusión: antes, el anillo perdía el hueco (cilindro sólido).
  Después, conserva el hueco real con la pupila visible adentro
  (confirmado por captura de pantalla con zoom).
- Hover 2D: antes tiraba `ReferenceError` (confirmado leyendo el código —
  la constante no existía). Después, opacity pasa de 0 a 0.18 sin error.
- Selección 2D + mouse afuera: antes volvía a opacity 0 (invisible).
  Después mantiene opacity 0.22 / color `#7c6cff` sin cambios.
- Relleno de selección: confirmado por captura con zoom que el relleno de
  la cabeza (idx6) deja un hueco limpio exactamente donde está el ojo,
  sin bleed.

Sin errores de consola nuevos en ningún caso. Sintaxis del archivo
completo validada con `node --check`.

## 2026-07-28 — Doble contorno al hacer zoom en piezas anidadas (DXF): causa raíz real y fix definitivo

**Síntoma reportado:** haciendo zoom en el visor 2D (sin extruir nada
todavía) sobre piezas anidadas del Tucan (anillo del ojo, pupila), cada
contorno se veía duplicado: dos líneas casi superpuestas pero con un
radio claramente distinto (gap visible de ~1.8mm en el caso del ojo).

**Investigación descartada primero (importante para no repetir el
error):** el usuario insistió, con razón, en que esto NO estaba en el
diseño original de CorelDRAW — llevó los mismos DXF/SVG exportados de
vuelta a Corel y confirmó con Tab/eliminar que cada círculo visible es un
único objeto, sin nada más encima ni cerca. La hipótesis inicial ("son
dos objetos de Corel genuinamente superpuestos") era incorrecta.

**Causa raíz real, encontrada en dos capas:**

1. `DXFParser.dedupeShapes` (ya existía) tenía como clave de
   deduplicación `layer + color`. Corel exportó el mismo trazo del
   anillo del ojo DOS VECES como entidades DXF distintas (handles `63` y
   `6A`, 33 vértices idénticos, distancia máxima 0.000000mm probando
   todas las rotaciones/sentidos) pero con colores distintos (blanco y
   naranja) — un artefacto del propio exportador de Corel, no del
   diseño. Como la clave incluía color, ese par nunca se reconocía como
   duplicado y ambas copias quedaban dibujadas. Fix: la clave ya no
   incluye color (sí sigue incluyendo layer); si hay colores distintos
   para el mismo trazo, gana el color que aparece más tarde en el
   archivo (mismo criterio de "lo de después es más autoritativo" que ya
   usa el resto del pipeline). Se aplicó el mismo dedup a `SVGParser`
   (reutilizando `DXFParser.dedupeShapes`), que no tenía ninguno.

2. Con la geometría ya deduplicada, `DXFParser.buildDXFPaintItems` (el
   fix de la entrada del 2026-07-25 para recuperar huecos reales como la
   pupila) seguía produciendo un doble contorno, ahora por una causa
   distinta: cuando una pieza más chica (el anillo del ojo, ya
   deduplicado) queda ANTES en el archivo que una pieza más grande que
   la contiene geométricamente (la cabeza), esa pieza grande la tapa por
   completo en el resolver original y "desaparece". El fix de esa fecha
   trataba TODA pieza desaparecida como un hueco: la recortaba como
   anillo extra del contenedor y la descartaba como ítem propio. Eso es
   correcto para un hueco real (nada debajo, debe quedar transparente),
   pero el anillo del ojo NO es un hueco — es una pieza sólida naranja
   que solo quedó mal ordenada. Al descartarla, quedaba un hueco vacío
   exactamente donde antes estaba, y ese hueco dejaba asomar el contorno
   de la pieza de fondo (el cuerpo fusionado) con el MISMO trazo que el
   borde recién cortado — de ahí el doble contorno con gap visible.

   (Se probaron dos variantes intermedias antes de llegar al fix final,
   documentadas acá para no repetirlas: (a) mantener la pieza desaparecida
   como ítem propio ADEMÁS del hueco cortado — duplica la misma curva dos
   veces, mismo síntoma. (b) aplicar esa misma lógica a TODAS las piezas
   desaparecidas sin distinción — hace que huecos reales como la pupila y
   el agujero del llavero dejen de ser transparentes y se conviertan en
   discos sólidos propios, tapando el hueco real que el fix del
   2026-07-25 había recuperado.)

**Fix final:** distinguir geométricamente dos casos entre las piezas que
desaparecen bajo el resolver original (color no sirve como señal: BYLAYER
hace que piezas sin color propio —cuerpo, agujero del llavero— hereden el
mismo color de capa que piezas con relleno real):

- **Hueco simple** (no contiene ninguna otra forma adentro, ej. pupila,
  agujero del llavero): se recorta como anillo extra de **todos** los
  contenedores válidos que lo contienen (no solo el más chico/directo —
  si no, una pieza compuesta más grande que también lo contiene le asoma
  un resto sólido propio justo en el hueco), y no se conserva como ítem
  visible propio. Mismo comportamiento que el fix del 2026-07-25.
- **Pieza compuesta** (contiene otra forma dibujada adentro, ej. el
  anillo del ojo, que tiene el anillo interior y la pupila dentro): se
  reubica justo después de su contenedor real en el orden de pintado, sin
  duplicar su geometría. El resolver, con el nuevo orden, resta su área
  del contenedor exactamente igual que ya hace con ala/pico/patas al
  superponerse al cuerpo — no hace falta ningún caso especial ni anillo
  extra.

**Verificación** (Chrome DevTools MCP, importando `Modelos/Tucan.dxf` y
`Modelos/Tucan.svg` por el botón real de la UI, no datos simulados):

- Zoom extremo sobre el borde compartido cabeza/anillo del ojo: ya no hay
  gap con dos círculos de radio distinto — solo el trazo fino coincidente
  esperable entre dos piezas adyacentes (comparado contra el pico, una
  pieza aislada que nunca pasó por este mecanismo: ahí se ve una sola
  línea limpia, confirmando que el trazo fino coincidente es
  comportamiento normal de bordes compartidos, no el bug).
- Extrusión 3D: el anillo del ojo se extruye sólido con su propio color y
  el hueco del anillo interior bien cortado (`_holeIdxs` correcto); la
  pupila y el agujero del llavero se extruyen como huecos reales
  (transparentes, se ve el fondo del visor a través — confirmado por
  captura), no como discos sólidos.
- Ala/pico/patas (piezas que nunca "desaparecen" bajo el resolver
  original): sin cambios, un solo trazo limpio.
- Import SVG: mismo resultado limpio sin tocar `SVGParser` más allá del
  dedup ya aplicado — el orden de un SVG ya refleja el z-order real, así
  que el anillo del ojo nunca llega a "desaparecer" ahí.
- Sintaxis del archivo completo validada con `node --check` en cada paso.
- Instrumentación de debug temporal (`window.__DXF_DEBUG__`) usada
  durante la investigación, retirada antes de este commit.

## 2026-07-28 (seguimiento) -- La pieza compuesta se "reubicaba", pero quedaba duplicada

**Sintoma:** despues del commit `753e0a7`, el diagnostico conceptual del
doble contorno era correcto (distinguir huecos simples de piezas
compuestas), pero la implementacion tenia una contradiccion: el comentario
decia "reubicadas ... sin duplicar geometria", mientras el codigo dejaba la
pieza compuesta en el `order` original y ademas la insertaba de nuevo despues
de su contenedor. Eso podia mantener exactamente el tipo de duplicacion que
se estaba intentando eliminar.

**Fix:** `order` ahora arranca solo con piezas no desaparecidas. Luego se
insertan explicitamente las piezas compuestas desaparecidas despues de su
contenedor real. Si por alguna razon el contenedor no esta en la lista, se
agrega al final en vez de usar `indexOf(...) + 1` con `-1`.

**Version visible:** se subio la version HTML/Electron a `1.0.3`. El cambio
anterior estaba deployado en Vercel, pero seguia mostrando `v1.0.2`, asi que
era imposible distinguir visualmente si se estaba abriendo el build nuevo.

**Desktop local:** al probar `npm start`, la app se caia antes de crear la
ventana porque el proceso heredaba `ELECTRON_RUN_AS_NODE=1`. En ese modo,
`electron.exe` ejecuta `main.js` como Node y `require('electron')` devuelve
la ruta del binario en vez de las APIs `app`/`BrowserWindow`; por eso
`electron-updater` fallaba con `Cannot read properties of undefined (reading
'getVersion')`. `main.js` ahora detecta ese caso al principio, relanza
Electron con esa variable limpia y sale del proceso Node intermedio.

**Release desktop:** GitHub Releases seguia en `v1.0.1`; no habia tag/release
`v1.0.2`. Por lo tanto el cambio web no podia llegar a la app instalada por
auto-update hasta publicar un nuevo release/installer.

## 2026-07-28 -- v1.0.4: bordes compartidos sin huecos ni paredes residuales

### Diagnostico corregido

El doble contorno no era solamente visual ni demostraba que el diseño de
Corel tuviera un objeto duplicado. El resolver de capas expandia
`coveredAbove` en `0.04 mm` antes de restarlo de cada pieza inferior. La pieza
superior conservaba su tamaño original, pero la inferior se recortaba 0.04 mm
de mas: entre ambas quedaba un clearance fisico real, visible en 2D y
exportable/extruible como hueco.

La medicion automatizada lo reprodujo con dos rectangulos: el borde superior
comenzaba en `x=5.00000` y el inferior terminaba en `x=4.96000`. En
`Modelos/Tucan.dxf`, el mismo mecanismo eliminaba `7.40667 mm2` de area neta.

### Solucion

`SVGVisibleGeometry.resolve()` vuelve a realizar la resta booleana exacta:

```text
visible_i = painted_i - union(painted_above)
```

La expansion fisica de cobertura fue eliminada. Para conservar el objetivo
del fix anterior (evitar paredes producidas por aproximaciones casi
coincidentes), se agrego una regularizacion topologica localizada:

- solo considera componentes conectados con ancho efectivo menor o igual a
  `0.01 mm`;
- exige que al menos 95% del componente este junto a una pieza superior;
- transfiere ese residuo a la pieza superior mediante union booleana;
- nunca borra el residuo dejando vacio, ni expande globalmente los contornos.

Por eso el area total y la silueta exterior se conservan. Una forma fina pero
separada de otra pieza tambien queda intacta.

### Fronteras coincidentes de Corel

Dos entidades geometricamente coincidentes no significan necesariamente dos
objetos duplicados en el diseño. En un dibujo por capas, una misma frontera
puede representar el hueco de una forma inferior y el borde de la forma
superior. Los comentarios del parser ahora describen esta distincion para no
volver a diagnosticar el archivo de Corel como duplicado sin evidencia.

### SVG con clases CSS

La misma revision encontro que Corel guarda los rellenos del Tucan SVG en
clases CSS (`fil0` a `fil3`). `SVGLoader` r128 no aplicaba esas reglas a
`path.color`, por lo que todas las piezas SVG llegaban negras. `SVGParser`
ahora resuelve `fill` desde estilo inline, atributo directo o clases CSS del
documento. El fixture conserva cuatro colores.

### Prueba de regresion

Se agrego `electron/tests/geometry-regression.js` y el comando
`npm run test:geometry`. La prueba abre el HTML real en Electron y recorre:

- borde compartido exacto: gap `0.00000 mm`;
- residuo casi coincidente: reasignado sin perder area;
- forma fina separada: preservada;
- importacion real por la UI de `Tucan.dxf` y `Tucan.svg`;
- extrusión separada de todas las regiones solidas;
- generacion y lectura interna de ambos 3MF;
- verificacion de mallas cerradas por aristas geometricas;
- capturas 2D y 3D de ambos formatos.

Resultados: DXF `17` contornos / `11` piezas / `4296` triangulos; SVG `19`
contornos / `12` piezas / `12680` triangulos. En ambos casos:
`0` mallas invalidas, `0` piezas fallidas al exportar y `0` aristas no
manifold. Version HTML/Electron: `1.0.4`.

### Guia de mantenimiento

El modelo del diseno por capas, el proceso de investigacion, las alternativas
descartadas, los invariantes y el protocolo de pruebas quedaron consolidados
en `GEOMETRY_PIPELINE.md`. Debe leerse antes de modificar importacion,
resolucion booleana, extrusion o exportacion.

## 2026-07-28 -- v1.0.5: undo/redo determinista y camara estable al importar

### Sintoma reportado

Despues de extruir correctamente una cara, deshacer y volver a seleccionarla
cerca de un borde, a veces se extruia un anillo como pared fina. El problema
era intermitente y favorecia el click inmediato despues de `Ctrl+Z`.

### Causas relacionadas

La auditoria encontro varias diferencias entre el estado original y el
reconstruido:

- `restoreSnapshot()` recreaba los `flatMesh` sin los huecos directos que
  `populateShapeData()` usaba durante la importacion. La geometria de picking
  2D cambiaba despues de undo.
- los meshes nuevos podian recibir un raycast antes del siguiente render,
  cuando sus matrices mundiales todavia no estaban actualizadas;
- el snapshot guardaba `sel2D`, pero no `selectedIdxs` ni `selectedFaces`;
  distintas partes de la UI podian discrepar sobre que estaba seleccionado;
- las lineas de contorno 3D competian con las areas rellenas de picking. Cerca
  del borde, una linea sin lado interior/exterior podia ganar y elegir el
  anillo adyacente;
- redo reconstruia huecos, pero no registraba de forma explicita las islas
  solidas incluidas dentro de ellos;
- duplicar una re-extrusion conservaba la malla clonada, pero perdia
  referencias a huecos cuyo padre seguia siendo el contorno fuente;
- ocultar y aislar piezas no agregaban un snapshot propio.

### Solucion

- La construccion de superficies 2D inicial y restaurada comparte ahora
  `directHoleShapes()`.
- `restoreSnapshot()` fuerza `matrixWorld` antes de volver a aceptar clicks.
- El historial serializa y restaura la seleccion unificada, sus caras y el
  modo de extrusion.
- El picking 3D prioriza areas de cara, luego superficie solida y usa lineas
  solo como fallback.
- Cada pieza registra `_solidIslandIdxs`, ademas de `_holeIdxs`, para que la
  reconstruccion no tenga que inferir que material pertenecia a la extrusion.
- Los duplicados preservan referencias topologicas fuente cuando no existe un
  padre ficticio que remapear.
- Ocultar y aislar generan snapshots undoables.

### Camara durante importacion

`populateShapeData()` llamaba siempre a `Viewport.focusAll()`. La camara
parecia inmovil al terminar de leer el archivo, pero se desplazaba durante la
animacion de 400 ms posterior. La importacion ahora captura y restaura
posicion, quaternion, vector `up`, target orbital y zoom. Tambien cancela un
focus o zoom amortiguado pendiente. El atajo `F` conserva el encuadre manual.

### Regresion

`npm run test:geometry` ahora cubre, usando clicks y botones reales:

- click junto a borde, extruir, undo, mismo click y segunda extrusion;
- re-extrusion 3D en modos separado y unido;
- igualdad de malla, huecos, islas y altura a traves de undo/redo;
- descarte de la rama redo despues de una operacion nueva;
- seleccion unificada;
- ocultar, aislar, duplicar, borrar, cambiar color y agrupar;
- camara antes, inmediatamente despues y 650 ms despues de importar.

El delta de camara es `0` y todos los ciclos conservan firmas geometricas
identicas. Las pruebas DXF/SVG y 3MF de `v1.0.4` siguen pasando sin cambios.
Version HTML/Electron: `1.0.5`.

## 2026-07-28 -- v1.0.6: 3MF multipartes manifold para Bambu Studio

### Sintoma y diagnostico

El Tucan se veia oscurecido o con colores mezclados al abrir el 3MF y se
separaba incorrectamente al laminar. No era un problema de iluminacion: el
archivo exportado contenia mallas superpuestas y topologia invalida. La pieza
base tenia aristas abiertas/no-manifold y multiples componentes internos.

La investigacion se hizo desde cuatro fuentes, en este orden:

1. hechos confirmados del diseno por capas en Corel;
2. DXF y SVG originales de `Modelos/`;
3. inspeccion del 3MF defectuoso por indices, aristas y volumen firmado;
4. especificacion 3MF y codigo/importador de Bambu Studio.

Esto evito volver a atribuir el problema a contornos duplicados de Corel. La
causa estaba despues de la importacion: el modo unido conservaba shapes
superpuestos y el exportador tenia una reconstruccion distinta de la malla
mostrada, con supuestos incorrectos sobre indices y soldado de vertices.

### Solucion geometrica

- `Solid2D` crea un solido canonico antes de triangular mediante union
  incremental de Clipper en espacio entero.
- Viewport y exportador comparten ese mismo conjunto de poligonos.
- Un contacto exacto entre un hueco y su borde se regulariza localmente con
  el menor paso de grilla que produce un interior estricto. No se aplica
  offset global ni se altera una frontera que ya es valida.
- Las extrusiones sin bisel se exportan como prismas indexados: tapas y
  laterales comparten indices dentro de cada anillo, pero dos anillos que solo
  coinciden geometricamente no se sueldan por accidente.
- Las piezas biseladas conservan la malla renderizada con un soldado de
  tolerancia estricta.
- Antes de escribir el archivo se eliminan triangulos degenerados/duplicados,
  se orienta cada componente, se exige volumen positivo y se rechaza cualquier
  arista usada por una cantidad distinta de dos caras. La exportacion falla
  completa si una pieza no cumple.

### Estructura y materiales

El 3MF contiene un objeto mesh por pieza, una unica raiz de componentes y un
solo `build item`. Los colores se deduplican en un `colorgroup` y cada volumen
conserva su `pindex` y su extrusor correspondiente. La metadata adicional
describe nombres, extrusores y una paleta PLA portatil, sin fingir que el
archivo fue creado por Bambu Studio ni fijar una impresora concreta.

La misma funcion `generate3MFBlob()` alimenta tanto `Exportar 3MF` como
`Abrir en Bambu Studio`, por lo que no existen dos exportadores divergentes.

### Regresion

`npm run test:geometry` ahora comprueba:

- DXF y SVG separados;
- una pieza con bisel;
- el Tucan unido como base y re-extruido por capas;
- raiz unica, cantidad de volumenes, colores y extrusores;
- aristas manifold, winding coherente y volumen firmado positivo;
- inspeccion real con Bambu Studio CLI;
- laminado real: un objeto, `5752` triangulos, sin warning y G-code generado.

El fixture unido queda en `12` volumenes, `3` materiales y `5752` triangulos,
con `0` aristas abiertas/no-manifold. Version HTML/Electron: `1.0.6`.

## 2026-07-28 -- v1.0.7: seleccion representativa y holgura 3MF opcional

### Sincronizacion viewport-panel

El viewport podia seleccionar correctamente una subcara de una pieza unida,
pero el panel no siempre mostraba una fila seleccionada. No era un fallo del
raycast: las subcaras absorbidas conservan indices propios para re-extruir,
mientras que `_panelHidden` hace que la lista muestre solo la fila principal
de la pieza. `_patchItem()` comparaba exclusivamente el indice de esa fila.

Se mantuvieron ambos niveles en vez de perder precision:

- el estado conserva la subcara exacta;
- `_panelRepresentativeIdx()` resuelve la fila visible del mismo `piece`;
- seleccion y hover de la fila consideran cualquier subcara de esa pieza;
- `scrollToItem()` usa el representante y expande su grupo si estaba cerrado.

La regresion hace click real sobre un area de picking oculta del Tucan unido.
Comprueba que se selecciona esa subcara, se marca la fila principal y se abre
el grupo colapsado.

### Holgura solo al exportar

Se agrego un switch pequeno junto a `Exportar 3MF`, desactivado por defecto.
Cuando esta activo, tanto la descarga como `Abrir en laminador` solicitan una
separacion fisica de `0.001 mm`. El modelo, el historial y el viewport no se
modifican.

No se trasladan piezas ni se escala su bounding box. Una traslacion no puede
separar todos los contactos y un escalado introduce errores dependientes del
tamano. `applyExportClearance()` contrae cada malla manifold `0.0005 mm` por
superficie mediante los planos incidentes de cada vertice. Dos superficies
en contacto retroceden de forma simetrica y dejan `0.001 mm` entre ellas,
incluidas las caras verticales, superiores, inferiores y biseladas.

La malla contraida vuelve a pasar limpieza, orientacion, aristas cerradas y
volumen positivo antes de serializar. La precision del XML sube de cuatro a
seis decimales. Con el switch apagado no se llama a esta transformacion.

Las pruebas sinteticas miden `0.001 mm` lateral y vertical, y conservan cero
errores manifold. El Tucan con holgura mantiene `12` volumenes, `3` materiales
y `5752` triangulos; Bambu Studio lo inspecciona y lamina correctamente. Puede
advertir sobre voladizos flotantes por la separacion vertical solicitada.
Version HTML/Electron: `1.0.7`.

## 2026-07-28 -- v1.0.8: holgura 3MF configurable

El switch de separacion conserva `0.001 mm` como valor inicial, pero la
distancia ahora se edita junto al control. Acepta coma o punto decimal y hasta
seis decimales, que es la precision usada al serializar vertices en el 3MF.
Con el switch activo se exige un valor finito mayor que cero; un dato invalido
se marca en el campo y bloquea la exportacion con un mensaje concreto.

La configuracion sigue entrando por `currentExportOptions()`, fuente comun de
`Exportar 3MF` y `Abrir en laminador`. No se agrego un segundo camino ni se
modifico `State`: cambiar el valor solo afecta al blob que se esta generando.
Con el switch apagado se envia exactamente `clearanceMm: 0`, aunque el campo
mantenga otro valor preparado para una exportacion posterior.

La regresion opera el control real, escribe `0,0025` y comprueba que el
exportador recibe `0.0025`. Tambien conserva las mediciones sinteticas de
contacto lateral/vertical, la invariancia del proyecto, el contrato manifold
y el laminado real del Tucan en Bambu Studio. Version HTML/Electron: `1.0.8`.

## 2026-07-28 -- v1.0.9: vacios reales por ocupacion global de material

### Modelo corregido

El color verde mostrado en Corel es solo el fondo de la pagina. No se exporta
ni se usa para decidir huecos. La distincion correcta es geometrica:

- un hueco local de una pieza puede revelar material de otra capa;
- un vacio real es una region que queda sin material despues de considerar
  todas las piezas;
- la particion visible, la ocupacion global y la topologia de extrusion son
  preguntas relacionadas, pero no equivalentes.

El error anterior provenia de usar la jerarquia visual local para responder
las tres preguntas. En diseños solapados, un punto de muestra tambien puede
asignar una profundidad engañosa aunque las curvas sean validas.

### Solucion comun

`SVGVisibleGeometry.applyMaterialVoids()` calcula por separado la union de
todo el material pintado. Solo los anillos impares que permanecen dentro de
esa union se clasifican como vacios globales. Si ya existe el mismo contorno,
se marca esa entidad; si el hueco nace de la union de varias piezas, se crea
un borde sintetico no seleccionable.

Los vacios conservan metadatos en `State`, snapshots, proyectos y undo/redo.
No aparecen como filas ni objetivos de seleccion, pero su borde sigue visible
y `absorbChildren()` siempre los incorpora como holes de la pieza contenedora.

La identidad entre un borde original y uno booleano se verifica por
solapamiento, area y caja completa. Los vacios explicitos no tienen limite de
tamaño. Solo se ignoran residuos sinteticos sin entidad de origen cuyo ancho
efectivo sea menor o igual a la tolerancia geometrica existente de `0.01 mm`.

### SVG

SVG conserva subtrazados y reglas de relleno. Los `paintItems` ya construidos
por el parser son la fuente canonica de ocupacion; no se inspecciona color de
fondo ni se inventa una segunda interpretacion. Por eso la deteccion es
determinista tanto para un path compuesto como para un hueco delimitado por
varias formas.

### DXF

DXF no guarda fill-rule ni un identificador de objeto compuesto. Todos los
`LWPOLYLINE` del Tucan comparten owner y solo tienen handles consecutivos.
No existe una solucion universal para distinguir dos objetos anidados de dos
subtrazados usando solo ese formato.

Para los DXF exportados por Corel se agrego una inferencia acotada:

1. se forman corridas consecutivas de igual layer/color;
2. dentro de cada corrida solo se agrupan curvas con contencion real mayor o
   igual a `99.9%`;
3. formas disjuntas o parcialmente solapadas permanecen independientes;
4. esa reconstruccion se usa solo para la union de material.

`buildDXFPaintItems()` sigue controlando la particion visible sin cambios de
comportamiento. Separar ambos caminos evito que la deteccion de vacios
absorbiera alas, pico, patas u otras piezas legitimas.

### Forma de abordaje y regresion

El cambio se desarrollo con una secuencia de hipotesis medibles:

1. reproducir con los Tucan SVG/DXF reales;
2. separar visibilidad de ocupacion;
3. probar primero la union global;
4. rechazar una primera integracion DXF que alteraba la cantidad de piezas;
5. conservar el resolver visual y aislar la inferencia de material;
6. medir residuos de aproximacion y asociacion de contornos;
7. validar UI, extrusion, 3MF y laminado externo.

La regresion cubre agujero SVG explicito, region luego rellenada, hueco
formado por cuatro piezas, compuesto DXF y DXF rellenado posteriormente.
Tambien exige para ambos Tucan exactamente un vacio, cero filas/selecciones
de vacio y un hole incorporado a la extrusion.

Resultados finales: DXF `17` contornos / `11` piezas / `4296` triangulos;
SVG `19` contornos / `12` piezas / `12680` triangulos. Todos los 3MF tienen
cero aristas abiertas/no-manifold, winding coherente y volumen positivo.
Bambu Studio reconoce una raiz, lamina un objeto y genera G-code. Version
HTML/Electron: `1.0.9`.

### Publicacion atomica del release

El primer workflow de `v1.0.9` termino con estado exitoso, pero el log mostro
dos instancias concurrentes del publicador de `electron-builder`. Ambas
intentaron crear el mismo release; GitHub conservo inicialmente solo el
blockmap y no rechazo el job. El release se reparo subiendo manualmente el
instalador probado, su blockmap correspondiente y `latest.yml`.

Para no repetir ese falso positivo, el workflow ya no usa
`electron-builder --publish always`. Ahora:

1. compila con `--publish never`;
2. obtiene version/tag desde `package.json`;
3. consulta si el release ya existe y solo lo crea cuando falta;
4. un unico comando reemplaza los tres artefactos declarados;
5. vuelve a listar los assets y hace fallar el job si falta cualquiera.

La ruta de release existente evita actualizar metadatos: GitHub devuelve
`422 tag_name already_exists` al intentar ese `PATCH` en este repositorio,
pero permite reemplazar assets. Esto separa compilacion de distribucion,
evita carreras al crear el release y permite reintentos idempotentes.
