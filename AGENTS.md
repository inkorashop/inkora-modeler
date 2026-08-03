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
- Despues de terminar y validar un cambio, hacer commit + push a `main`.
  El proyecto de Vercel (`inkora-modeler`) esta conectado por Git desde
  el 2026-07-25 (ver DECISIONS.md) y despliega solo en cada push -- no
  hace falta correr `vercel --prod` a mano, pero el push si es un paso
  obligatorio, no opcional. No dejar cambios validados sin commitear.
