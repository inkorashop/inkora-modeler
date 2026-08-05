# INKORA Modeler - instrucciones para agentes

Antes de trabajar en este proyecto, leer el contexto compartido de INKORA:

- `C:\Users\compu\Desktop\INKORA IA\INKORA Workspace\README.md`
- `C:\Users\compu\Desktop\INKORA IA\INKORA Workspace\PROJECTS.md`
- `C:\Users\compu\Desktop\INKORA IA\INKORA Workspace\AGENTS.md`
- `C:\Users\compu\Desktop\INKORA IA\INKORA Workspace\COREL_AUTOMATION.md`
- `C:\Users\compu\Desktop\INKORA IA\INKORA Workspace\LOCAL_APP_STRUCTURE.md`

La raiz tecnica del repo vive en:

```powershell
C:\Users\compu\Desktop\INKORA IA\INKORA 3D Modeler\Proyecto
```

La distribucion local se documenta en `LOCAL_DISTRIBUTION.md`.

Luego revisar el estado local:

```powershell
git status --short --branch
```

Antes de modificar importacion DXF/SVG, booleanas, contornos, extrusion o
exportacion 3MF, leer `GEOMETRY_PIPELINE.md`. Contiene los invariantes, las
hipotesis descartadas y el metodo de regresion del pipeline geometrico.

Reglas especificas:

- No modificar archivos en `Viejo/` salvo pedido explicito.
- Cuidar precision geometrica, exportaciones y comportamiento visual.
- No tocar otros proyectos de INKORA desde este repo.
- No subir configuraciones locales ni secretos.
- Despues de terminar y validar un cambio (`npm run test:geometry` en
  verde), el cierre estandar de la tanda es: commit + push a `main` +
  `npm run distribute:local`. Es la autorizacion estandar para este repo:
  no hace falta preguntar cada vez ni esperar confirmacion para el push o
  para regenerar la distribucion -- son parte del mismo flujo de cerrar una
  tanda validada, no un paso aparte. Preguntar solo si el cambio no paso la
  regresion, si toca algo fuera de este repo, o si el usuario pidio
  explicitamente no commitear/pushear en esa tanda.
  El proyecto de Vercel (`inkora-modeler`) esta conectado por Git desde
  el 2026-07-25 (ver DECISIONS.md) y despliega solo en cada push -- no
  hace falta correr `vercel --prod` a mano, pero el push si es un paso
  obligatorio, no opcional. No dejar cambios validados sin commitear.

## Fuente unica y publicacion

`index.html` es la fuente canonica. De ahi salen los tres destinos, no se
edita ninguno por separado:

| destino | como se actualiza |
| --- | --- |
| Acceso directo / `npm start` | lee `index.html` del repo, al instante |
| Web (Vercel) | push a `main` |
| `INKORA 3D Modeler.html` externo, portable e instalador | `distribute:local` |

**Al cerrar una tanda de cambios validados hay que regenerar la distribucion
local**, no solo commitear:

```powershell
cd Proyecto\electron
npm.cmd run distribute:local
```

Ese comando corre la regresion, empaqueta instalador y portable, copia los
dos `.exe`, el HTML y `vendor/` a la carpeta externa, y regenera el acceso
directo. Sin ese paso, los `.exe` quedan en la version anterior y el usuario
sigue viendo codigo viejo. No hace falta correrlo en cada commit intermedio
de una misma tanda: tarda varios minutos porque empaqueta dos veces.

Cambios en `electron/main.js` o `electron/preload.js` **no viajan** por
Vercel ni por el HTML externo: solo llegan al portable y al instalador
regenerando la distribucion.

Las librerias (three, SVGLoader, BufferGeometryUtils, Clipper, JSZip) viven
en `vendor/` y se cargan con ruta relativa, para que la app funcione sin
internet. **`vendor/` es siempre el camino principal**: no reemplazarlo por
un CDN. Si se agrega una libreria, va a `vendor/` y tambien a
`extraResources` en `electron/package.json`.

Desde el 2026-08-04 hay ademas un **respaldo por CDN** en el `<head>`, que
solo dispara si una libreria no aparecio en `vendor/` -- el caso de llevarse
suelto el `.html` a otra PC. Con `vendor/` presente no se pide nada por red.
Las URLs estan clavadas a la version exacta y con `integrity`, y los
archivos son byte-identicos a los de `vendor/`. Si se actualiza una libreria
hay que actualizar las dos puntas: el archivo en `vendor/` y la URL + hash
SRI del respaldo. Ver DECISIONS.md (2026-08-04).
