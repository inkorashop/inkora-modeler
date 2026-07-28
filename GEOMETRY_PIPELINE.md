# Pipeline geometrico de INKORA

Este documento explica el modelo geometrico del programa, la investigacion
que llevo al fix `v1.0.4` y el metodo que debe usarse para diagnosticar cambios
futuros. Complementa el registro cronologico de `DECISIONS.md`.

## 1. Modelo del diseno

Los archivos de Corel se construyen visualmente por superposicion:

- piezas como alas, patas, pico y ojo pueden estar encima de otras;
- quitar una pieza superior deja visible la pieza inferior, no un vacio;
- algunos disenos incluyen al fondo una silueta con todas las piezas
  fusionadas y otros no;
- una frontera coincidente puede cumplir dos funciones distintas: borde de
  una pieza superior y recorte visible de una pieza inferior.

Por eso, dos curvas coincidentes en el archivo no demuestran que Corel haya
exportado dos veces el mismo objeto. Tampoco es necesario reconstruir toda la
estructura de capas de Corel. El programa necesita interpretar correctamente
el orden de pintado y convertirlo en regiones 2D visibles, adyacentes y
extrudibles.

Conviene separar cuatro niveles al razonar sobre un fallo:

1. **Geometria fuente:** entidades DXF o elementos SVG.
2. **Piezas pintadas:** regiones cerradas con orden, color y pertenencia.
3. **Geometria visible:** resultado 2D de resolver superposiciones.
4. **Solidos:** triangulacion y extrusion de cada region visible.

Una coincidencia en el nivel 1, un error booleano en el nivel 3 y una pared
incorrecta en el nivel 4 pueden verse parecidos, pero requieren soluciones
completamente distintas.

## 2. Invariantes

Todo cambio en importacion o extrusion debe conservar estas propiedades:

- dos piezas adyacentes comparten una unica frontera geometrica;
- no se agrega separacion fisica para resolver una ambiguedad numerica;
- la union del material visible conserva la silueta y el area;
- las piezas visibles no se solapan en area despues de aplanar las capas;
- un hueco real sigue siendo hueco;
- una pieza fina real no se elimina por parecer un residuo;
- una aproximacion casi coincidente no crea una pared fina independiente;
- DXF y SVG deben producir semantica equivalente, aunque representen color,
  orden y curvas de manera diferente;
- toda region extrudida debe producir una malla cerrada y exportable.

Las tolerancias pueden ayudar a clasificar una condicion, pero no deben
alterar globalmente el diseno ni crear o quitar material.

## 3. Como se investigo el doble contorno

La investigacion partio de tres observaciones confirmadas en el uso real:

1. Corel no habia exportado dos veces el mismo contorno.
2. Se veian dos fronteras geometricas, no un efecto de render.
3. Al extruir ambas regiones quedaba un vacio fisico entre ellas.

Estas observaciones descartaron como explicacion principal el z-fighting, el
grosor de linea del visor y la duplicacion del archivo fuente.

### 3.1 Reproduccion minima

Antes de seguir modificando el Tucan se redujo el problema a dos rectangulos
que debian compartir el borde `x=5`. La medicion del resultado anterior fue:

```text
pieza superior: comienza en x=5.00000
pieza inferior: termina en x=4.96000
gap fisico:     0.04000 mm
```

Esto convirtio una captura ambigua en una diferencia cuantificable. Luego se
busco en el pipeline el valor exacto que explicaba esa distancia.

### 3.2 Causa raiz

`SVGVisibleGeometry.resolve()` expandia `coveredAbove` en `0.04 mm` antes de
restarlo de las piezas inferiores. La pieza superior conservaba su contorno,
pero la inferior se recortaba de mas.

El mecanismo habia sido agregado para evitar paredes muy finas cuando dos
curvas destinadas a coincidir llegaban con pequenas diferencias numericas.
Sin embargo, resolvia ese caso creando un clearance real y exportable.

En el Tucan DXF, el comportamiento anterior eliminaba `7.40667 mm2` de area
neta. El doble contorno era la manifestacion visible de esa perdida.

### 3.3 Revision adyacente

La investigacion no se limito al punto que dibujaba la linea. Se revisaron:

- deduplicacion y orden de entidades DXF;
- deteccion de huecos y piezas compuestas;
- resolucion de superposiciones;
- conversion de curvas a poligonos de Clipper;
- triangulacion, extrusion y exportacion 3MF;
- importacion del mismo modelo como DXF y SVG;
- empaquetado del mismo HTML en Electron y Vercel.

Esa revision encontro un problema independiente: Corel guarda los colores del
SVG del Tucan en clases CSS (`fil0` a `fil3`) y el loader no las trasladaba a
`path.color`. Se corrigio como parte de la misma validacion transversal, sin
mezclarlo con la solucion topologica.

## 4. Solucion de v1.0.4

La operacion principal vuelve a ser una resta booleana exacta:

```text
visible_i = painted_i - union(painted_above)
```

Clipper sigue siendo el motor de poligonos. No se implementaron booleanas
geometricas a mano.

Para las aproximaciones casi coincidentes se agrego una regularizacion local
en `regularizeCoincidentEdges()`:

- solo considera componentes hoja y de profundidad par;
- exige ancho efectivo menor o igual a `0.01 mm`;
- busca una pieza superior cuyo vecindario cubra al menos el 95% del residuo;
- en empate elige la capa superior mas cercana;
- transfiere el residuo a esa pieza mediante union booleana;
- retira el residuo de la pieza inferior solo despues de transferirlo.

La tolerancia se usa para determinar propiedad topologica, no para desplazar
la frontera. El material cambia de propietario, pero no desaparece y no se
crea un hueco.

### Por que no se rehizo todo

Los parsers, Clipper, la triangulacion y la exportacion ya resolvian partes
correctas del problema. La causa estaba concentrada en la transformacion de
geometria pintada a visible. Reemplazar todo el pipeline habria ampliado el
riesgo sin eliminar mejor la causa.

La parte que si se rehizo conceptualmente fue la estrategia de tolerancia:
se abandono el offset global destructivo y se lo reemplazo por una decision
local de propiedad con conservacion de area.

## 5. Soluciones descartadas

No volver a aplicar estas estrategias sin nueva evidencia y pruebas:

- **Culpar al archivo de Corel por curvas coincidentes.** Una frontera puede
  tener roles validos distintos dentro de un diseno por capas.
- **Deduplicar todas las curvas iguales.** Puede fusionar entidades con
  semantica, color u orden diferentes.
- **Expandir o contraer coberturas globalmente.** Convierte una tolerancia
  numerica en perdida o agregado de material.
- **Borrar componentes por debajo de un area minima grande.** Tambien borra
  detalles finos legitimos.
- **Conservar el residuo y la pieza superior.** Produce una pared o pieza
  independiente entre regiones.
- **Tratar toda pieza oculta como hueco.** Convierte piezas solidas en vacios.
- **Tratar todo hueco como pieza solida.** Tapa pupilas, anillas y agujeros
  reales.
- **Reconstruir todas las capas de Corel.** Es complejidad innecesaria para
  obtener la particion visible y no es universal entre disenos.
- **Validar solo con una captura 2D.** Un render correcto no garantiza una
  malla cerrada ni un 3MF correcto.

## 6. Estrategia de pruebas

La regresion vive en `electron/tests/geometry-regression.js` y se ejecuta con:

```powershell
cd electron
npm run test:geometry
```

La prueba abre el HTML real dentro de Electron y valida:

- dos rectangulos con borde exacto: gap `0.00000 mm`;
- residuo casi coincidente de `0.005 mm`: transferido sin perder area;
- detalle separado de `0.005 mm`: preservado;
- importacion real por la UI de `Modelos/Tucan.dxf`;
- importacion real por la UI de `Modelos/Tucan.svg`;
- extrusiones separadas;
- generacion y lectura interna del 3MF;
- mallas cerradas por conteo de aristas geometricas;
- capturas 2D y 3D para inspeccion visual.

Referencia aprobada de `v1.0.4`:

| Formato | Contornos | Piezas | Colores | Triangulos |
| --- | ---: | ---: | ---: | ---: |
| DXF | 17 | 11 | 3 | 4296 |
| SVG | 19 | 12 | 4 | 12680 |

Ambos deben mantener `0` mallas invalidas, `0` fallos de exportacion y `0`
aristas no manifold.

Una cifra distinta no implica automaticamente un bug, porque un cambio de
fixture puede modificarla. Si cambia sin haber modificado los modelos, debe
investigarse antes de actualizar la referencia.

## 7. Metodo para cambios futuros

Seguir este orden:

1. Registrar lo que el usuario confirma sobre el archivo y el resultado.
2. Determinar en cual de los cuatro niveles aparece por primera vez el fallo.
3. Medir distancia, area, cantidad de regiones y topologia; no inferir causa
   solo desde el color del render.
4. Crear un caso sintetico minimo que reproduzca una sola propiedad.
5. Comparar ese caso con los fixtures DXF y SVG reales.
6. Buscar la transformacion exacta que viola un invariante.
7. Corregir esa transformacion con la menor regla general necesaria.
8. Probar tambien el caso opuesto: huecos reales, piezas finas y formas
   separadas.
9. Validar 2D, extrusion, malla y exportacion.
10. Confirmar que HTML, Electron y web ejecutan el mismo archivo validado.

Si una propuesta necesita excepciones por nombre de pieza, color concreto o
modelo del Tucan, probablemente todavia no expresa la regla geometrica real.

## 8. Version y publicacion

El HTML de la raiz es la fuente canonica de interfaz y geometria. Electron lo
empaqueta y Vercel lo sirve como aplicacion web. Son tres destinos del mismo
codigo, pero cada destino debe publicarse y verificarse:

- HTML local: version visible y metadato `inkora-version`;
- Electron: version de `electron/package.json`, paquete de prueba e
  instalador/release;
- Vercel: deployment de produccion disparado por el push a `main`.

Antes de publicar:

```powershell
cd electron
npm run test:geometry
npm run dist:test
npm run dist:installer
```

Despues del push, verificar el release de Electron, el estado `Ready` de
Vercel y la version que entrega el alias publico. El estado del deployment no
reemplaza la comprobacion del contenido servido.

## 9. Historial, picking y camara

Desde `v1.0.5`, un snapshot geometrico tambien debe conservar:

- seleccion unificada (`selectedIdxs` y `selectedFaces`);
- huecos e islas solidas que integran cada pieza;
- indices fuente usados por piezas ficticias, fusionadas o duplicadas;
- visibilidad y modo de extrusion.

Restaurar no termina al crear objetos Three.js. Antes de aceptar interaccion
se deben actualizar sus matrices mundiales, porque un click puede ocurrir en
el mismo frame que `Ctrl+Z`.

En 3D, el orden de picking es:

1. area rellena de una sub-cara;
2. superficie solida;
3. linea de contorno como ultimo recurso.

Una linea no determina de que lado del borde hizo click el usuario y no debe
ganar sobre una cara valida.

Importar DXF/SVG no encuadra la escena. Debe preservar posicion, orientacion,
target orbital y zoom, ademas de cancelar animaciones pendientes. El encuadre
continua siendo una accion explicita mediante `F`.

## 10. Solido canonico y contrato 3MF

Desde `v1.0.6`, una pieza unida no es una lista de shapes que se extruyen en
paralelo. Primero se transforma en un conjunto canonico de poligonos:

```text
contornos logicos
  -> union incremental Clipper
  -> shapes canonicos sin bordes internos duplicados
  -> triangulacion para viewport y exportacion
```

La union es incremental porque una union masiva puede conservar segmentos
coincidentes en la salida de ciertas composiciones. El resultado debe cumplir:

- ninguna arista interna repetida;
- ningun offset global;
- conservacion de area salvo una regularizacion topologica localizada;
- huecos e islas expresados por anillos, no inferidos desde triangulos.

Un punto donde un hueco toca exactamente su exterior no representa un solido
2-manifold extruible. `regularizeTouchingHole()` mueve solo ese vertice hacia
el interior valido, buscando desde el paso minimo de la grilla. No debe
aplicarse a huecos separados ni convertirse en una tolerancia general.

### Contrato de malla exportada

Cada mesh del 3MF debe cumplir antes de serializar:

1. todo triangulo tiene tres indices distintos y area no nula;
2. no existen triangulos duplicados;
3. cada arista por indices aparece exactamente dos veces;
4. los dos usos de una arista tienen direccion opuesta;
5. cada componente conectado tiene volumen firmado positivo.

La coincidencia de coordenadas no basta para definir identidad topologica.
Dos anillos que tocan un punto pueden usar coordenadas iguales y vertices con
indices distintos. Soldarlos globalmente crea una arista o vertice
no-manifold.

### Contrato multipartes y color

Un modelo multicolor se escribe como:

- un objeto mesh por volumen;
- un unico objeto raiz con componentes;
- un unico item en `build`;
- un `colorgroup` con colores unicos;
- `pid/pindex` por volumen;
- metadata de nombre/extrusor y arrays de paleta con igual longitud.

INKORA se conserva como `Application`. No usar el prefijo `BambuStudio-`:
Bambu lo interpreta como proyecto nativo y espera perfiles completos de
maquina, proceso, placa y filamentos. Inventar esa identidad crea archivos
fragiles. Un 3MF estandar debe dejar que Bambu use los perfiles locales.

### Regresion externa

Cuando Bambu Studio esta instalado, `npm run test:geometry` ejecuta tambien:

```powershell
bambu-studio --info fixture.3mf
bambu-studio --slice 0 --outputdir <temp> fixture.3mf
```

La prueba exige una sola raiz ensamblada, cero aristas abiertas/no-manifold,
un unico objeto laminado, la misma cantidad de triangulos que el 3MF y G-code
no vacio. Los materiales se comprueban en el XML y la metadata porque el CLI
headless no presenta el dialogo de conversion de colores del flujo grafico.
