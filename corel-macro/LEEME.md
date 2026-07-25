# Macro de CorelDRAW — copiar vectores directo a INKORA 3D Modeler

Permite copiar una selección de vectores en CorelDRAW y pegarla directo en
INKORA 3D Modeler con `Ctrl+V`, sin exportar/importar un archivo a mano.

Es una instalación única por PC/instalación de Corel — no hay que volver a
instalarla salvo que se reinstale CorelDRAW.

## Por qué una macro y no algo 100% externo

Se investigó automatizar esto sin instalar nada dentro de Corel (un script
externo conectándose por COM). Falló siempre con
`MK_E_UNAVAILABLE`: CorelDRAW no se registra de forma confiable en la
Running Object Table de Windows, así que ningún proceso externo puede
engancharse a la instancia abierta. Es una limitación de CorelDRAW, no de
este proyecto. Detalle completo en `../DECISIONS.md` (2026-07-25).

La macro no sufre este problema porque corre adentro del proceso de Corel
y ya tiene la referencia viva (`ActiveDocument`) sin necesidad de buscarla
desde afuera.

## Instalación (una sola vez)

1. En CorelDRAW: `Alt+F11` para abrir el editor VBA.
2. Clic derecho en **GlobalMacros** (o el proyecto de macros globales) →
   *Importar archivo…* → elegir `InkoraCopySvg.bas` (esta carpeta).
3. Listo. La macro queda disponible como
   `InkoraCopySvg.CopySelectionAsSvgForInkora` en todos los documentos.

## Uso

1. En CorelDRAW: seleccionar uno o más vectores.
2. Ejecutar la macro `InkoraCopySvg.CopySelectionAsSvgForInkora`
   (Alt+F8 → elegirla → Ejecutar; o asignarle un atajo de teclado propio
   desde Herramientas → Personalización → Comandos).
3. En INKORA 3D Modeler: `Ctrl+V`. Se importa como si fuera un archivo
   `.dxf` (mismo parser, mismos huecos/capas/colores detectados).

## Qué hace por dentro

Exporta la selección activa a un `.dxf` temporal (`ActiveDocument.ExportEx`,
filtro `CDR_DXF`, rango `CDR_SELECTION`) y escribe ese texto directo al
portapapeles de Windows como `CF_UNICODETEXT` (API Win32 `OpenClipboard` /
`SetClipboardData`). No depende de ninguna librería externa ni de que
INKORA esté abierto en ese momento.
