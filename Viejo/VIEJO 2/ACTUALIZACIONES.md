# ACTUALIZACIONES — INKORA Keychain 3D Modeler

Registro de cambios del programa. Cada entrada indica fecha, hora y un
resumen breve de lo realizado.

---

## 2026-07-03

### 20:10 — v2.0.1 · Corrección tras primera prueba real (logo AKRAPOVIC)

Tres bugs reportados al probar con un DXF real de texto sin color:

- **Modelo importado "perdido" fuera de la grilla**: los DXF traen
  coordenadas absolutas del lienzo original (a veces lejos del origen); la
  grilla del visor está fija en (0,0). Ahora el documento se **recentra
  automáticamente en el origen** al importar (`js/dxf.js`), así el modelo
  siempre aparece sobre la grilla sin importar de dónde venían las
  coordenadas en el archivo original.

- **Letras ENTERAS detectadas como huecos vacíos** (no solo su interior):
  el clasificador anterior asumía que "mismo color que el padre" siempre
  significa alternancia sólido/hueco (como la contra de una letra). Pero
  muchos DXF de logos/texto no traen color por objeto (todo en la capa "0",
  sin código 62/420) — en ese caso, letra y base "comparten" el mismo
  *sin color*, y la letra completa terminaba tratada como un agujero. Se
  reescribió `js/topology.js` con un criterio geométrico: un agujero real
  de compound path (la contra de una "O") nunca contiene otra figura
  adentro, y un agujero perforado funcional (la argolla) es siempre
  redondeado — se usa la **compacidad del contorno** (4π·Área/Perímetro²)
  como discriminante para figuras sin color ni capa propia. Esto resuelve
  el caso reportado sin requerir que el DXF traiga colores.

- **Atajos de teclado que "no existían"**: `Ctrl+1` y `Ctrl+2` (caras
  superiores/inferiores) son atajos **reservados a nivel de navegador**
  (Chrome/Edge/Firefox los usan para cambiar de pestaña) — la página nunca
  llega a recibirlos, ni siquiera con `preventDefault()`. Se reemplazaron
  por teclas simples sin conflicto: **`T`** (caras superiores) y **`B`**
  (caras inferiores), consistente con `E`/`F`/`H` ya existentes. El resto
  de los atajos (`Ctrl+A`, `Ctrl+Z`, `Ctrl+S`, etc.) sí son interceptables
  por la página y quedan sin cambios.

**Verificación:** suite de Node ampliada a 60/60 (se agregó un caso de
regresión específico: logo con 8 "letras" + una "O" compuesta + argolla,
todo sin color, replicando el bug reportado) y prueba de humo en navegador
real que dispara los atajos de teclado tal como los usaría el usuario
(`E`, `Ctrl+A`, `T`, `B`, `Ctrl+Z`/`Ctrl+Shift+Z`, `H`, `F`, `Escape`,
`Delete`), sin errores de consola.

---

### 21:05 — v2.0.2 · Atajos de teclado idénticos a la versión anterior

Se pidió que todos los atajos volvieran a ser los mismos que en la versión
anterior (la v25 tenía un editor de atajos configurable con una tabla de
valores por defecto; se tomó esa tabla como referencia exacta). Se
reescribió el mapa completo en `js/main.js` y se agregaron las acciones
que faltaban en el modelo (`js/model.js`) y la interfaz (`js/ui.js`):

| Tecla | Acción | Estado |
|---|---|---|
| `F` | Encuadrar escena | ya existía |
| `A` | Seleccionar todo | **corregido**: antes era `Ctrl+A` por error — este era el atajo que el usuario reportó como "no existe" |
| `Esc` | Deseleccionar todo | ya existía |
| `I` | Invertir selección | **nuevo** |
| `E` | Extruir selección | ya existía |
| `O` | Alternar modo de extrusión (separadas/unidas) | **nuevo** |
| `C` | Color de la selección, junto al cursor | **nuevo** |
| `Supr` | Eliminar selección | ya existía |
| `H` | Ocultar / mostrar selección | ya existía |
| `Alt+I` | Aislar selección (de nuevo: mostrar todo) | **nuevo** |
| `F2` | Renombrar | ya existía |
| `Ctrl+Z` / `Ctrl+Shift+Z` | Deshacer / rehacer | ya existía |
| `Ctrl+G` | Agrupar | ya existía |
| `Ctrl+U` | Desagrupar | **cambiado** de `Ctrl+Shift+G` |
| `Ctrl+D` | Duplicar pieza seleccionada | **nuevo** |
| `Ctrl+I` | Importar DXF | ya existía |
| `Ctrl+V` | Pegar desde CorelDRAW | ya existía |
| `Ctrl+E` | Exportar 3MF | **cambiado** de `Ctrl+S` |

Se agregaron botones en el panel para las acciones nuevas (Invertir,
Duplicar, Aislar) además del atajo de teclado, para que sean descubribles
sin memorizar la tecla.

**Caso especial — `Ctrl+1`/`Ctrl+2` (caras superiores/inferiores):**
quedaron definidos en el código exactamente igual que en la versión
anterior, pero **todos los navegadores** (Chrome, Edge, Firefox) reservan
esa combinación para cambiar de pestaña a nivel de sistema — la página
nunca recibe el evento, ni con `preventDefault()`. Esto es una limitación
del navegador, no del código (la versión anterior tenía el mismo problema).
Se agregaron **`T`** y **`B`** como equivalentes sin conflicto, documentados
en el modal de ayuda como la forma confiable de usar ese atajo.

**No implementado:** `Ctrl+O` (abrir proyecto) y `Ctrl+S` (guardar
proyecto) de la versión anterior no tienen equivalente — esta reescritura
no tiene un formato de proyecto propio, solo el flujo importar DXF →
extruir → exportar 3MF.

**Verificación:** suite de Node en 69/69 (se agregaron pruebas de
invertir/duplicar/aislar) y prueba de humo en navegador que dispara cada
atajo nuevo (`A`, `I`, `O`, `Ctrl+U`, `Ctrl+D`, `Alt+I`, `Ctrl+1`) además
de los ya existentes, sin errores de consola.

---

### 18:45 — v2.0.0 · Reescritura completa desde cero

**Arquitectura nueva** (antes: un único HTML de 332 KB; ahora: módulos ordenados):

```
INKORA.html          maquetado principal (se abre con doble clic / Abrir INKORA.bat)
css/inkora.css       tema claro de marca: blanco + azul marino
js/utils.js          utilidades (geometría 2D, colores, tabla ACI)
js/dxf.js            parser DXF (polilíneas, bulge, arcos, círculos, elipses, splines NURBS)
js/topology.js       clasificación sólido / interior respaldado / hueco vacío real
js/model.js          estado del documento y todas las operaciones
js/history.js        deshacer/rehacer por snapshots completos
js/exporter.js       3MF multicolor + escritor ZIP propio (adiós JSZip)
js/scene.js          reconstrucción de la escena 3D desde el modelo
js/viewport.js       render bajo demanda, cámara orbital, selección por raycast
js/ui.js             panel, lista de elementos, colores, renombrar, agrupar
js/main.js           arranque, importación (archivo/arrastre/portapapeles) y atajos
js/vendor/three.min.js  Three.js embebido (funciona 100% sin internet)
corel/INKORA-Corel.bas  macro de CorelDRAW (copiar selección como DXF → Ctrl+V)
```

**Bugs del programa anterior corregidos:**

- **Re-extrusión**: las piezas guardan referencias a sus contornos de origen
  (no copias), por lo que re-extruir una cara superior/inferior conserva
  SIEMPRE los agujeros interiores. Verificado con test automático.
- **Interior de letra vs. hueco vacío**: nuevo clasificador topológico por
  árbol de contención + paridad + color. El interior de una "O" apoyada en
  la base es una cara extruible; el agujero de la argolla (sin nada detrás)
  es vacío real y no se puede seleccionar ni rellenar.
- **Blanco puro desde DXF**: el índice de color ACI 7 se interpreta siempre
  como `#ffffff`; también se lee color verdadero (código 420) y BYLAYER.
- **Eliminación de piezas extruidas**: al borrar una pieza, sus caras 2D de
  origen vuelven a estar disponibles automáticamente.
- **Historial Ctrl+Z / Ctrl+Shift+Z**: reescrito por snapshots completos del
  estado (antes deltas incrementales que se corrompían). Deshacer/rehacer
  es ahora una restauración exacta, imposible de desincronizar.

**Mejoras:**

- Tema claro de marca (blanco + azul marino), tipografía del sistema,
  interfaz mínima y moderna.
- Funciona 100% offline: Three.js embebido, sin CDNs; JSZip eliminado
  (escritor ZIP propio de 90 líneas).
- Ya no hace falta el helper de PowerShell: la macro de Corel deja el DXF
  en el portapapeles y el navegador lo recibe con Ctrl+V nativo.
- Extrusión inteligente: cada cara se apoya automáticamente sobre lo que
  tenga debajo (base → letras encima → detalles encima), sin solapamientos
  de color en el laminador y sin huecos.
- Exportación 3MF: un objeto por pieza con su `displaycolor`; mallas
  manifold por construcción (cada arista pertenece a exactamente 2
  triángulos). BambuStudio/OrcaSlicer asignan un filamento por color sin
  mezclas ni reparaciones.
- Altura de piezas editable después de extruir; modo "Separadas"/"Unidas";
  agrupar/desagrupar/renombrar (F2, doble clic); ocultar/mostrar (H);
  selección masiva de caras superiores (Ctrl+1) e inferiores (Ctrl+2);
  render bajo demanda (fluido y sin gastar GPU de fondo).
- Parser DXF más completo: POLYLINE/LWPOLYLINE con arcos *bulge*, ARC,
  CIRCLE, ELLIPSE, SPLINE (NURBS racional), encadenado de LINEs sueltas en
  contornos cerrados, unidades vía `$INSUNITS` (todo se normaliza a mm) y
  detección de contornos duplicados.

**Verificación:** 53/53 pruebas automáticas en Node (parser, colores,
topología, extrusión/re-extrusión, borrado, undo/redo, grupos, 3MF válido,
mallas manifold, volumen exacto) + prueba de humo en navegador real
(importar → extruir → escena → exportar → undo/redo) sin errores de consola.

Los archivos de la versión anterior quedaron en `Viejo/`.
