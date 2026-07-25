Attribute VB_Name = "InkoraCopySvg"
Option Explicit

' INKORA - macro unica para CorelDRAW.
' Mantiene el nombre que Corel ya muestra:
'   InkoraCopySvg.CopySelectionAsSvgForInkora
' Pero internamente copia DXF al portapapeles, para que INKORA use
' exactamente el mismo importador que usa con archivos .dxf.

#If VBA7 Then
    Private Declare PtrSafe Function OpenClipboard Lib "user32" (ByVal hwnd As LongPtr) As Long
    Private Declare PtrSafe Function EmptyClipboard Lib "user32" () As Long
    Private Declare PtrSafe Function CloseClipboard Lib "user32" () As Long
    Private Declare PtrSafe Function SetClipboardData Lib "user32" (ByVal wFormat As Long, ByVal hMem As LongPtr) As LongPtr
    Private Declare PtrSafe Function GlobalAlloc Lib "kernel32" (ByVal wFlags As Long, ByVal dwBytes As LongPtr) As LongPtr
    Private Declare PtrSafe Function GlobalLock Lib "kernel32" (ByVal hMem As LongPtr) As LongPtr
    Private Declare PtrSafe Function GlobalUnlock Lib "kernel32" (ByVal hMem As LongPtr) As Long
    Private Declare PtrSafe Function GlobalFree Lib "kernel32" (ByVal hMem As LongPtr) As LongPtr
    Private Declare PtrSafe Sub CopyMemory Lib "kernel32" Alias "RtlMoveMemory" (ByVal Destination As LongPtr, Source As Any, ByVal Length As LongPtr)
#Else
    Private Declare Function OpenClipboard Lib "user32" (ByVal hwnd As Long) As Long
    Private Declare Function EmptyClipboard Lib "user32" () As Long
    Private Declare Function CloseClipboard Lib "user32" () As Long
    Private Declare Function SetClipboardData Lib "user32" (ByVal wFormat As Long, ByVal hMem As Long) As Long
    Private Declare Function GlobalAlloc Lib "kernel32" (ByVal wFlags As Long, ByVal dwBytes As Long) As Long
    Private Declare Function GlobalLock Lib "kernel32" (ByVal hMem As Long) As Long
    Private Declare Function GlobalUnlock Lib "kernel32" (ByVal hMem As Long) As Long
    Private Declare Function GlobalFree Lib "kernel32" (ByVal hMem As Long) As Long
    Private Declare Sub CopyMemory Lib "kernel32" Alias "RtlMoveMemory" (ByVal Destination As Long, Source As Any, ByVal Length As Long)
#End If

Private Const GMEM_MOVEABLE As Long = &H2
Private Const CF_UNICODETEXT As Long = 13
Private Const CDR_DXF As Long = 1296
Private Const CDR_SELECTION As Long = 2

Public Sub CopySelectionAsSvgForInkora()
    On Error GoTo EH

    If ActiveDocument Is Nothing Then
        MsgBox "No hay documento activo en CorelDRAW.", vbExclamation, "INKORA"
        Exit Sub
    End If

    If ActiveSelectionRange Is Nothing Or ActiveSelectionRange.Count = 0 Then
        MsgBox "Selecciona uno o mas vectores antes de copiar.", vbExclamation, "INKORA"
        Exit Sub
    End If

    Dim tempDxf As String
    tempDxf = Environ$("TEMP") & "\inkora_corel_export.dxf"

    On Error Resume Next
    Kill tempDxf
    On Error GoTo EH

    Dim ef As ExportFilter
    Set ef = ActiveDocument.ExportEx(tempDxf, CDR_DXF, CDR_SELECTION)
    ef.Finish

    Dim dxfText As String
    dxfText = ReadTextFile(tempDxf, "windows-1252")

    If InStr(1, dxfText, "SECTION", vbTextCompare) = 0 Or _
       InStr(1, dxfText, "ENTITIES", vbTextCompare) = 0 Then
        MsgBox "Corel exporto un archivo, pero no parece ser DXF valido.", vbCritical, "INKORA"
        Exit Sub
    End If

    PutUnicodeTextOnClipboard dxfText
    Exit Sub

EH:
    MsgBox "INKORA: no se pudo copiar la seleccion como DXF:" & vbCrLf & Err.Description, vbCritical, "INKORA"
End Sub

Private Function ReadTextFile(ByVal path As String, ByVal charsetName As String) As String
    Dim stm As Object
    Set stm = CreateObject("ADODB.Stream")
    stm.Type = 2
    stm.Charset = charsetName
    stm.Open
    stm.LoadFromFile path
    ReadTextFile = stm.ReadText
    stm.Close
End Function

Private Sub PutUnicodeTextOnClipboard(ByVal text As String)
    Dim bytes() As Byte
    bytes = text & vbNullChar

#If VBA7 Then
    Dim hMem As LongPtr
    Dim pMem As LongPtr
    Dim hSet As LongPtr
    Dim byteCount As LongPtr
#Else
    Dim hMem As Long
    Dim pMem As Long
    Dim hSet As Long
    Dim byteCount As Long
#End If

    byteCount = UBound(bytes) + 1
    hMem = GlobalAlloc(GMEM_MOVEABLE, byteCount)
    If hMem = 0 Then Err.Raise vbObjectError + 1000, , "No se pudo reservar memoria para el portapapeles."

    pMem = GlobalLock(hMem)
    If pMem = 0 Then
        GlobalFree hMem
        Err.Raise vbObjectError + 1001, , "No se pudo bloquear memoria del portapapeles."
    End If

    CopyMemory pMem, bytes(0), byteCount
    GlobalUnlock hMem

    If OpenClipboard(0) = 0 Then
        GlobalFree hMem
        Err.Raise vbObjectError + 1002, , "No se pudo abrir el portapapeles."
    End If

    EmptyClipboard
    hSet = SetClipboardData(CF_UNICODETEXT, hMem)
    CloseClipboard

    If hSet = 0 Then
        GlobalFree hMem
        Err.Raise vbObjectError + 1003, , "Windows no acepto el texto en el portapapeles."
    End If
End Sub
