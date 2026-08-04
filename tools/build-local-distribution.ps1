$ErrorActionPreference = 'Stop'

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $scriptRoot '..'))
$outerRoot = [System.IO.Path]::GetFullPath((Join-Path $projectRoot '..'))
$electronRoot = Join-Path $projectRoot 'electron'
$distRoot = Join-Path $electronRoot 'dist'
$iconPath = Join-Path $electronRoot 'build\icon.ico'
$developmentTarget = Join-Path $electronRoot 'node_modules\electron\dist\electron.exe'
$htmlSource = Join-Path $projectRoot 'index.html'
$vendorSource = Join-Path $projectRoot 'vendor'

$installerDestination = Join-Path $outerRoot 'INKORA 3D Modeler - Instalador.exe'
$portableDestination = Join-Path $outerRoot 'INKORA 3D Modeler - Portable.exe'
$htmlDestination = Join-Path $outerRoot 'INKORA 3D Modeler.html'
# El HTML carga las librerias desde vendor/ con ruta relativa: sin esta
# carpeta al lado, el archivo externo abre en blanco.
$vendorDestination = Join-Path $outerRoot 'vendor'
$shortcutDestination = Join-Path $outerRoot 'INKORA 3D Modeler.lnk'

function Invoke-Checked {
    param(
        [Parameter(Mandatory = $true)][string]$Command,
        [string[]]$Arguments = @()
    )

    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed ($LASTEXITCODE): $Command $($Arguments -join ' ')"
    }
}

function Publish-Artifact {
    param(
        [Parameter(Mandatory = $true)][string]$Source,
        [Parameter(Mandatory = $true)][string]$Destination
    )

    $temp = "$Destination.tmp"
    Copy-Item -LiteralPath $Source -Destination $temp -Force
    Move-Item -LiteralPath $temp -Destination $Destination -Force
}

if ((Split-Path -Leaf $projectRoot) -ne 'Proyecto') {
    throw "This script must live inside the Proyecto/tools folder."
}

if (-not (Test-Path -LiteralPath $electronRoot -PathType Container)) {
    throw "Electron project not found: $electronRoot"
}

if (-not (Test-Path -LiteralPath $iconPath -PathType Leaf)) {
    throw "Icon not found: $iconPath"
}

if (-not (Test-Path -LiteralPath $developmentTarget -PathType Leaf)) {
    throw "Development Electron runtime not found: $developmentTarget"
}

if (-not (Test-Path -LiteralPath $htmlSource -PathType Leaf)) {
    throw "HTML source not found: $htmlSource"
}

if (-not (Test-Path -LiteralPath $vendorSource -PathType Container)) {
    throw "Vendor libraries not found: $vendorSource"
}

Push-Location $electronRoot
try {
    Invoke-Checked 'npm.cmd' @('run', 'test:geometry')
    Invoke-Checked (Join-Path $electronRoot 'node_modules\.bin\electron-builder.cmd') @('--win', 'nsis', 'portable')
}
finally {
    Pop-Location
}

$installer = Get-ChildItem -LiteralPath $distRoot -File -Filter '*.exe' |
    Where-Object { $_.Name -match 'Setup|Instalador' } |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

$portable = Get-ChildItem -LiteralPath $distRoot -File -Filter '*.exe' |
    Where-Object { $_.Name -match 'Portable' -or $_.Name -notmatch 'Setup|Instalador' } |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

if (-not $installer) {
    throw "Installer artifact not found in $distRoot"
}

if (-not $portable) {
    throw "Portable artifact not found in $distRoot"
}

Get-Process | Where-Object {
    $_.Path -and
    ([System.IO.Path]::GetFullPath($_.Path) -ieq [System.IO.Path]::GetFullPath($portableDestination))
} | ForEach-Object {
    Stop-Process -Id $_.Id -Force
}

Publish-Artifact $installer.FullName $installerDestination
Publish-Artifact $portable.FullName $portableDestination
Publish-Artifact $htmlSource $htmlDestination

if (Test-Path -LiteralPath $vendorDestination) {
    Remove-Item -LiteralPath $vendorDestination -Recurse -Force
}
Copy-Item -LiteralPath $vendorSource -Destination $vendorDestination -Recurse -Force

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutDestination)
$shortcut.TargetPath = $developmentTarget
$shortcut.Arguments = '.'
$shortcut.WorkingDirectory = $electronRoot
$shortcut.IconLocation = "$iconPath,0"
$shortcut.Description = 'Abrir INKORA 3D Modeler'
$shortcut.Save()

Write-Host "Installer: $installerDestination"
Write-Host "Portable:  $portableDestination"
Write-Host "HTML:      $htmlDestination"
Write-Host "Vendor:    $vendorDestination"
Write-Host "Shortcut:  $shortcutDestination"
