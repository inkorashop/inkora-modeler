# ============================================================
#  INKORA Clipboard Helper
#  Detecta Ctrl+C en CorelDRAW, convierte la seleccion a SVG
#  y lo pone en el clipboard como texto para que INKORA pueda
#  importarlo con Ctrl+V.
#
#  Requiere: Windows 10, PowerShell 5+, CorelDRAW abierto.
#  No requiere instalacion de AutoHotkey ni ningun otro programa.
# ============================================================

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# --- Win32: clipboard listener + info de ventana activa ---
Add-Type @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
public class InkoraWin32 {
    [DllImport("user32.dll")] public static extern bool AddClipboardFormatListener(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool RemoveClipboardFormatListener(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    public static string ForegroundProcessName() {
        try {
            IntPtr h = GetForegroundWindow(); uint pid = 0;
            GetWindowThreadProcessId(h, out pid);
            return Process.GetProcessById((int)pid).ProcessName;
        } catch { return ""; }
    }
}
'@

# --- Formulario del helper: visible y tambien recibe WM_CLIPBOARDUPDATE ---
Add-Type -ReferencedAssemblies @("System.Windows.Forms.dll") -TypeDefinition @'
using System;
using System.Windows.Forms;
public class ClipWatcher : Form {
    public const int WM_CLIPBOARDUPDATE = 0x031D;
    public Action OnUpdate;
    public ClipWatcher() {
        ShowInTaskbar = true;
        WindowState = FormWindowState.Normal;
        FormBorderStyle = FormBorderStyle.FixedToolWindow;
        Width = 220;
        Height = 42;
        TopMost = true;
    }
    protected override void WndProc(ref Message m) {
        if (m.Msg == WM_CLIPBOARDUPDATE && OnUpdate != null) OnUpdate();
        base.WndProc(ref m);
    }
}
'@

# --- Estado global ---
$script:corel          = $null
$script:settingClip    = $false
$script:tempSvg        = "$env:TEMP\inkora_corel_export.svg"
$script:lastSvgHash    = ""
$script:lastClipTime   = "Sin eventos"
$script:lastProc       = "Sin datos"
$script:lastStatus     = "Helper activo"
$script:lastSvgInfo    = "Sin SVG exportado"
$script:lastError      = ""
$script:panelExpanded  = $false
$script:statusForm     = $null
$script:statusLabel    = $null
$script:detailLabel    = $null
$script:logPath        = Join-Path $PSScriptRoot "inkora-helper.log"

function Write-HelperLog {
    param([string]$Message)
    try {
        $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $Message"
        Add-Content -LiteralPath $script:logPath -Value $line -Encoding UTF8
    } catch {}
}

function NowText {
    return (Get-Date).ToString("HH:mm:ss")
}

function Update-FloatingStatus {
    param(
        [string]$Status,
        [string]$Proc,
        [string]$SvgInfo,
        [string]$ErrorText
    )

    if ($Status)    { $script:lastStatus  = $Status }
    if ($Proc)      { $script:lastProc    = $Proc }
    if ($SvgInfo)   { $script:lastSvgInfo = $SvgInfo }
    if ($ErrorText -ne $null) { $script:lastError = $ErrorText }

    if ($script:statusLabel -ne $null) {
        $script:statusLabel.Text = "INKORA - " + $script:lastStatus
    }
    if ($script:detailLabel -ne $null) {
        $err = if ([string]::IsNullOrWhiteSpace($script:lastError)) { "OK" } else { $script:lastError }
        $script:detailLabel.Text = "Ultimo clipboard: $($script:lastClipTime)`r`nVentana detectada: $($script:lastProc)`r`nEstado: $($script:lastStatus)`r`nSVG: $($script:lastSvgInfo)`r`nDetalle: $err`r`n`r`nClick para plegar/desplegar."
    }

    Write-HelperLog "Status=$($script:lastStatus); Proc=$($script:lastProc); SVG=$($script:lastSvgInfo); Error=$($script:lastError)"
}

function New-FloatingStatus {
    if ($script:form -ne $null -and -not $script:form.IsDisposed) {
        $form = $script:form
        $form.Controls.Clear()
    } else {
        $form = New-Object System.Windows.Forms.Form
    }
    $form.Text = "INKORA Helper"
    $form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedToolWindow
    $form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
    $form.TopMost = $true
    $form.ShowInTaskbar = $true
    $form.BackColor = [System.Drawing.Color]::FromArgb(20, 24, 28)
    $form.ForeColor = [System.Drawing.Color]::White
    $form.ClientSize = New-Object System.Drawing.Size(220, 42)
    $form.Opacity = 1
    $form.WindowState = [System.Windows.Forms.FormWindowState]::Normal

    $screen = [System.Windows.Forms.Screen]::FromPoint([System.Windows.Forms.Cursor]::Position).WorkingArea
    $form.Left = $screen.Right - $form.Width - 18
    $form.Top = $screen.Top + 18

    $status = New-Object System.Windows.Forms.Label
    $status.AutoSize = $false
    $status.Left = 0
    $status.Top = 0
    $status.Width = $form.ClientSize.Width
    $status.Height = 42
    $status.TextAlign = [System.Drawing.ContentAlignment]::MiddleCenter
    $status.Font = New-Object System.Drawing.Font("Segoe UI", 9, [System.Drawing.FontStyle]::Bold)
    $status.BackColor = [System.Drawing.Color]::FromArgb(130, 255, 70)
    $status.ForeColor = [System.Drawing.Color]::Black
    $status.Text = "INKORA - Helper activo"

    $detail = New-Object System.Windows.Forms.Label
    $detail.AutoSize = $false
    $detail.Left = 12
    $detail.Top = 52
    $detail.Width = 336
    $detail.Height = 142
    $detail.Font = New-Object System.Drawing.Font("Consolas", 8)
    $detail.ForeColor = [System.Drawing.Color]::Gainsboro
    $detail.BackColor = [System.Drawing.Color]::FromArgb(20, 24, 28)

    $toggle = {
        $script:panelExpanded = -not $script:panelExpanded
        if ($script:panelExpanded) {
            $script:statusForm.ClientSize = New-Object System.Drawing.Size(360, 210)
            $script:statusLabel.Width = 360
            $script:detailLabel.Visible = $true
        } else {
            $script:statusForm.ClientSize = New-Object System.Drawing.Size(220, 42)
            $script:statusLabel.Width = 220
            $script:detailLabel.Visible = $false
        }
        $screen = [System.Windows.Forms.Screen]::FromPoint([System.Windows.Forms.Cursor]::Position).WorkingArea
        $script:statusForm.Left = $screen.Right - $script:statusForm.Width - 18
        Update-FloatingStatus -Status $null -Proc $null -SvgInfo $null -ErrorText $null
    }

    $status.Add_Click($toggle)
    $detail.Add_Click($toggle)
    $form.Add_Click($toggle)
    $form.Add_FormClosing({
        Write-HelperLog "Floating panel closing"
        try { [InkoraWin32]::RemoveClipboardFormatListener($script:form.Handle) | Out-Null } catch {}
        if ($script:tray -ne $null) { $script:tray.Visible = $false }
        [System.Windows.Forms.Application]::ExitThread()
    })

    $detail.Visible = $false
    $form.Controls.Add($status)
    $form.Controls.Add($detail)

    $script:statusForm = $form
    $script:statusLabel = $status
    $script:detailLabel = $detail

    Update-FloatingStatus -Status "Helper activo" -Proc "Esperando CorelDRAW" -SvgInfo "Sin SVG exportado" -ErrorText ""
    $form.Show()
    $form.TopMost = $false
    $form.TopMost = $true
    $form.BringToFront()
    $form.Activate()
    Write-HelperLog "Floating panel shown at Left=$($form.Left), Top=$($form.Top), Width=$($form.Width), Height=$($form.Height)"
    return $form
}

function Show-FloatingStatus {
    try {
        if ($script:statusForm -eq $null -or $script:statusForm.IsDisposed) {
            $script:floating = New-FloatingStatus
        } else {
            $script:statusForm.Show()
            $script:statusForm.WindowState = [System.Windows.Forms.FormWindowState]::Normal
            $script:statusForm.TopMost = $false
            $script:statusForm.TopMost = $true
            $script:statusForm.BringToFront()
            $script:statusForm.Activate()
            Write-HelperLog "Floating panel brought to front"
        }
    } catch {
        Write-HelperLog "ERROR showing floating panel: $($_.Exception.Message)"
    }
}

# --- Icono de sistema tray ---
function New-TrayIcon {
    $icon  = [System.Drawing.SystemIcons]::Application
    $tray  = New-Object System.Windows.Forms.NotifyIcon
    $tray.Icon    = $icon
    $tray.Text    = "INKORA · Clipboard Helper activo"
    $tray.Visible = $true

    $menu = New-Object System.Windows.Forms.ContextMenu
    $itemStatus = New-Object System.Windows.Forms.MenuItem("Helper activo  -  CorelDRAW Ctrl+C → Ctrl+V en INKORA")
    $itemStatus.Enabled = $false
    $itemExit   = New-Object System.Windows.Forms.MenuItem("Cerrar helper")
    $itemExit.Add_Click({
        [InkoraWin32]::RemoveClipboardFormatListener($script:form.Handle)
        $script:tray.Visible = $false
        [System.Windows.Forms.Application]::Exit()
    })
    $menu.MenuItems.Add($itemStatus) | Out-Null
    $menu.MenuItems.Add("-")         | Out-Null
    $menu.MenuItems.Add($itemExit)   | Out-Null
    $tray.ContextMenu = $menu
    return $tray
}

# --- Obtener SVG de CorelDRAW via COM ---
function Get-CorelSVG {
    try {
        $cdrSVG = 1345
        $cdrSelection = 2

        # Conectar a CorelDRAW (debe estar abierto)
        if ($script:corel -eq $null) {
            $script:corel = [Runtime.InteropServices.Marshal]::GetActiveObject("CorelDRAW.Application")
            Write-HelperLog "Connected to CorelDRAW COM"
        }

        $doc = $script:corel.ActiveDocument
        if ($doc -eq $null) {
            Update-FloatingStatus -Status "Corel sin documento" -Proc $null -SvgInfo $null -ErrorText "No hay documento activo en CorelDRAW"
            return $null
        }

        # Verificar que haya seleccion. Segun version de Corel, la seleccion
        # puede exponerse como ActiveSelectionRange, ActiveSelection o doc.Selection.
        $selCount = $null
        try {
            $sr = $script:corel.ActiveSelectionRange
            if ($sr -ne $null) { $selCount = [int]$sr.Count }
            Write-HelperLog "ActiveSelectionRange.Count=$selCount"
        } catch {
            Write-HelperLog "ActiveSelectionRange unavailable: $($_.Exception.Message)"
        }

        if ($selCount -eq $null) {
            try {
                $sel = $script:corel.ActiveSelection
                if ($sel -ne $null -and $sel.Shapes -ne $null) { $selCount = [int]$sel.Shapes.Count }
                Write-HelperLog "ActiveSelection.Shapes.Count=$selCount"
            } catch {
                Write-HelperLog "ActiveSelection unavailable: $($_.Exception.Message)"
            }
        }

        if ($selCount -eq $null) {
            try {
                $sel = $doc.Selection
                if ($sel -ne $null -and $sel.Shapes -ne $null) { $selCount = [int]$sel.Shapes.Count }
                Write-HelperLog "Document.Selection.Shapes.Count=$selCount"
            } catch {
                Write-HelperLog "Document.Selection unavailable: $($_.Exception.Message)"
            }
        }

        if ($selCount -eq $null -or $selCount -le 0) {
            Update-FloatingStatus -Status "Corel sin seleccion" -Proc $null -SvgInfo $null -ErrorText "Corel no reporto objetos seleccionados"
            return $null
        }

        Write-HelperLog "Selection accepted: $selCount object(s)"

        # Eliminar SVG anterior si existe
        try {
            if (Test-Path $script:tempSvg) {
                Remove-Item $script:tempSvg -Force -ErrorAction SilentlyContinue
            }
        } catch {}

        # ExportEx(fileName, filterType, exportRange)
        #   filterType  1345 = cdrSVG
        #   exportRange  2    = cdrSelection
        Write-HelperLog "ExportEx starting. File=$script:tempSvg; Filter=$cdrSVG; Range=$cdrSelection"
        $ef = $doc.ExportEx($script:tempSvg, $cdrSVG, $cdrSelection)
        $ef.Finish()
        Write-HelperLog "ExportEx finished"

        # Esperar que CorelDRAW escriba el archivo
        $waited = 0
        while (-not (Test-Path $script:tempSvg) -and $waited -lt 3000) {
            Start-Sleep -Milliseconds 100; $waited += 100
        }

        if (Test-Path $script:tempSvg) {
            $size = (Get-Item -LiteralPath $script:tempSvg).Length
            Write-HelperLog "Temp SVG exists. Size=$size bytes"
            $txt = [System.IO.File]::ReadAllText($script:tempSvg, [System.Text.Encoding]::UTF8)
            if ($txt -match '<svg') {
                Update-FloatingStatus -Status "SVG exportado" -Proc $null -SvgInfo "$($txt.Length) caracteres" -ErrorText ""
                return $txt
            }
            Update-FloatingStatus -Status "SVG invalido" -Proc $null -SvgInfo "$size bytes" -ErrorText "El archivo exportado no contiene etiqueta <svg>"
        } else {
            Write-HelperLog "Temp SVG was not created"
            Update-FloatingStatus -Status "Export fallo" -Proc $null -SvgInfo "Sin archivo SVG" -ErrorText "Corel no creo el SVG temporal"
        }
    }
    catch {
        $script:corel = $null   # forzar reconexion la proxima vez
        Write-Host "[INKORA Helper] Error CorelDRAW COM: $_"
        Write-HelperLog "ERROR CorelDRAW COM: $($_.Exception.Message)"
        Update-FloatingStatus -Status "Error Corel COM" -Proc $null -SvgInfo $null -ErrorText $_.Exception.Message
    }
    return $null
}

# --- Callback al cambiar el clipboard ---
function On-ClipboardChanged {
    # Ignorar cambios que nosotros mismos provocamos
    if ($script:settingClip) { return }

    # Solo actuar si CorelDRAW era la ventana activa
    $proc = [InkoraWin32]::ForegroundProcessName()
    $script:lastClipTime = NowText
    Update-FloatingStatus -Status "Clipboard detectado" -Proc $proc -SvgInfo $null -ErrorText ""

    if ($proc -notlike "*CorelDRAW*" -and $proc -notlike "*Corel*") {
        Update-FloatingStatus -Status "Ignorado: no era Corel" -Proc $proc -SvgInfo $null -ErrorText "El clipboard cambio desde otra ventana"
        return
    }

    Write-Host "[INKORA Helper] Clipboard cambiado desde CorelDRAW, exportando SVG..."
    Update-FloatingStatus -Status "Corel detectado" -Proc $proc -SvgInfo "Exportando..." -ErrorText ""

    # Dar 150ms para que CorelDRAW termine de escribir al clipboard
    Start-Sleep -Milliseconds 150

    $svg = Get-CorelSVG
    if ($svg -ne $null -and $svg.Length -gt 50) {
        # Evitar reemplazar si el SVG es el mismo (loop protection)
        $md5 = [System.Security.Cryptography.MD5]::Create()
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($svg)
        $hashBytes = $md5.ComputeHash($bytes)
        $hashStr = [BitConverter]::ToString($hashBytes).Replace("-", "")
        if ($hashStr -eq $script:lastSvgHash) { return }
        $script:lastSvgHash = $hashStr

        $script:settingClip = $true
        try {
            [System.Windows.Forms.Clipboard]::SetText($svg)
            Write-Host "[INKORA Helper] SVG en clipboard ($($svg.Length) chars). Ahora pega con Ctrl+V en INKORA."
            Update-FloatingStatus -Status "Listo para pegar" -Proc $proc -SvgInfo "$($svg.Length) caracteres en clipboard" -ErrorText ""
            $script:tray.BalloonTipTitle = "INKORA Helper"
            $script:tray.BalloonTipText  = "SVG listo. Pega con Ctrl+V en INKORA."
            $script:tray.ShowBalloonTip(2000)
        } finally {
            Start-Sleep -Milliseconds 50
            $script:settingClip = $false
        }
    } else {
        Write-Host "[INKORA Helper] No se pudo obtener SVG (sin seleccion o CorelDRAW no disponible)."
        if ($script:lastStatus -eq "Corel detectado" -or $script:lastStatus -eq "Clipboard detectado") {
            Update-FloatingStatus -Status "No obtuvo SVG" -Proc $proc -SvgInfo "Sin SVG" -ErrorText "Sin seleccion o CorelDRAW no disponible"
        } else {
            Update-FloatingStatus -Status $null -Proc $proc -SvgInfo $null -ErrorText $script:lastError
        }
    }
}

# --- Entrada principal ---
[System.Windows.Forms.Application]::EnableVisualStyles()
Write-HelperLog "Helper starting. Script=$PSCommandPath"

Write-Host "============================================"
Write-Host " INKORA Clipboard Helper iniciado"
Write-Host " Abre CorelDRAW, selecciona objetos y Ctrl+C"
Write-Host " Luego Ctrl+V en INKORA 3D."
Write-Host " Clic derecho en el icono de bandeja para cerrar."
Write-Host "============================================"

$script:form = New-Object ClipWatcher
Write-HelperLog "ClipWatcher form created"
$script:form.OnUpdate = { On-ClipboardChanged }
try {
    $handle = $script:form.Handle
    $listenerOk = [InkoraWin32]::AddClipboardFormatListener($handle)
    $listenerText = if ($listenerOk -eq $true) { "True" } elseif ($listenerOk -eq $false) { "False" } else { "NULL" }
    Write-HelperLog "Clipboard listener registered: $listenerText; Handle=$handle"
} catch {
    Write-HelperLog "ERROR registering clipboard listener: $($_.Exception.Message)"
}

$script:tray = New-TrayIcon
Write-HelperLog "Tray icon created"
Show-FloatingStatus

# Mostrar burbuja de bienvenida
$script:tray.BalloonTipTitle = "INKORA Helper activo"
$script:tray.BalloonTipText  = "Copiá vectores en CorelDRAW y pegá con Ctrl+V en INKORA."
$script:tray.ShowBalloonTip(3000)

Write-HelperLog "Entering Windows Forms message loop"
[System.Windows.Forms.Application]::Run()
Write-HelperLog "Windows Forms message loop ended"
