@echo off
title INKORA 3D Modeler

:: INKORA ya no necesita ningun programa auxiliar en segundo plano:
:: el pegado desde CorelDRAW funciona directo con Ctrl+V en el navegador
:: (la macro corel\INKORA-Corel.bas deja el DXF en el portapapeles).

start "" "%~dp0INKORA.html"
exit
