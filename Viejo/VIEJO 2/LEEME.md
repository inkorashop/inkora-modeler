# INKORA · Keychain 3D Modeler

Modelador 3D de llaveros por extrusión: importa vectores **DXF**, extruye
por colores y exporta **3MF multicolor** listo para BambuStudio / OrcaSlicer
(un objeto por color: los colores nunca se mezclan en el laminador).

Funciona 100% offline en el navegador. No requiere instalación.

## Cómo abrir

Doble clic en **`Abrir INKORA.bat`** (o directamente en `INKORA.html`).

## Flujo de trabajo

1. **Importar** el vector:
   - `Ctrl+I` y elegir el archivo `.dxf`, o
   - arrastrar el `.dxf` a la ventana, o
   - en CorelDRAW ejecutar la macro `INKORA.CopiarSeleccion` y pegar acá con `Ctrl+V`.
2. **Seleccionar** caras en el visor 3D o en la lista de elementos
   (`Shift+clic` suma, `Ctrl+clic` alterna, `Ctrl+A` todo).
3. **Extruir** con `E` (altura en mm, modo *Separadas* o *Unidas*).
   Cada cara se apoya sola sobre lo que tenga debajo: primero la base,
   después las letras quedan automáticamente encima.
4. **Re-extruir**: clic en la cara superior (o inferior) de una pieza ya
   extruida y `E` de nuevo. Los agujeros interiores se conservan.
5. **Colores**: clic en el cuadradito de color de cada elemento, o botón
   "Color de la selección…" para varios a la vez.
6. **Exportar** con `Ctrl+S` → descarga el `.3mf`. En BambuStudio/OrcaSlicer
   abrirlo como *un objeto con varias partes* y asignar un filamento por color.

## Conceptos que el programa resuelve solo

- **Interior de letra** (ej. el centro de una "O" apoyada sobre la base):
  aparece como cara *interior* seleccionable y extruible por separado.
- **Hueco vacío real** (ej. el agujero de la argolla): se detecta porque no
  tiene material detrás; no se puede seleccionar ni rellenar jamás.
- **Blanco puro**: el color 7 del DXF se interpreta siempre como `#ffffff`.

## Atajos principales

Coinciden con los de la versión anterior de INKORA.

| Atajo | Acción |
|---|---|
| `Ctrl+I` / `Ctrl+V` | Importar DXF / pegar desde Corel |
| `A` | Seleccionar todo |
| `I` | Invertir selección |
| `T` / `B` | Todas las caras superiores / inferiores (equivalente confiable de `Ctrl+1`/`Ctrl+2`) |
| `E` | Extruir selección |
| `O` | Alternar modo de extrusión (separadas/unidas) |
| `C` | Color de la selección |
| `Supr` | Eliminar (las caras de origen se recuperan) |
| `H` | Ocultar / mostrar selección |
| `Alt+I` | Aislar selección |
| `Ctrl+D` | Duplicar pieza seleccionada |
| `Ctrl+Z` / `Ctrl+Shift+Z` | Deshacer / rehacer |
| `Ctrl+G` / `Ctrl+U` | Agrupar / desagrupar |
| `F` / `F2` | Encuadrar / renombrar |
| `Ctrl+E` | Exportar 3MF |
| `?` | Ver todos los atajos |

> `Ctrl+1`/`Ctrl+2` están reservados por el navegador (cambio de pestaña) y
> nunca llegan a la página — usá `T`/`B`, que hacen lo mismo y sí funcionan.

## Macro de CorelDRAW (opcional)

Permite copiar vectores directo de Corel sin exportar archivos:

1. En CorelDRAW: `Alt+F11` → clic derecho en **GlobalMacros** → *Importar
   archivo…* → elegir `corel/INKORA-Corel.bas`.
2. Uso: seleccionar los vectores → ejecutar `INKORA.CopiarSeleccion` →
   en INKORA presionar `Ctrl+V`.

## Estructura del proyecto

Ver el detalle de archivos y el registro de cambios en
[ACTUALIZACIONES.md](ACTUALIZACIONES.md). La versión anterior del programa
quedó archivada en `Viejo/`.
