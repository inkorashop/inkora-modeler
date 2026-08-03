# Distribucion local

INKORA 3D Modeler adopta el estandar optativo definido por
`INKORA Workspace\LOCAL_APP_STRUCTURE.md`.

## Estructura externa

```text
INKORA 3D Modeler/
|-- Proyecto/
|-- INKORA 3D Modeler - Instalador.exe
|-- INKORA 3D Modeler - Portable.exe
|-- INKORA 3D Modeler.html
`-- INKORA 3D Modeler.lnk
```

`Proyecto/` contiene el repositorio completo, incluido `.git`, el HTML vivo,
Electron, recursos, pruebas, macros y modelos de ejemplo. Los `.exe` externos,
el HTML externo y el acceso directo son artefactos locales reproducibles.

`INKORA 3D Modeler.html` es una copia estable del HTML vivo para abrirlo directo
en el navegador. Esta salida externa se mantiene por pedido explicito del
usuario; sigue dependiendo de las librerias CDN declaradas por el HTML fuente.

## Comando unico

Desde `Proyecto\electron`:

```powershell
npm.cmd run distribute:local
```

El comando ejecuta la regresion geometrica, genera instalador NSIS y portable
con Electron Builder, copia ambos `.exe` y el HTML a la carpeta externa con
nombres estables, y regenera `INKORA 3D Modeler.lnk` con el icono oficial de
`Proyecto\electron\build\icon.ico`.

El acceso directo externo abre la app desde el flujo de codigo fuente en
`Proyecto\electron`, usando el runtime local de Electron. El portable estable
queda disponible como ejecutable separado para uso sin instalacion.

Para desarrollo desde codigo fuente tambien se puede usar:

```powershell
cd Proyecto\electron
npm.cmd start
```
