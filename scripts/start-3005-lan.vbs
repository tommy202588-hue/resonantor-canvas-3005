Option Explicit

' Keep the 3005 supervisor independent of the Codex process tree. If the
' supervisor itself exits, retry it after a short delay.
Dim shell, projectRoot, nodeExe, command, fso
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

projectRoot = "C:\Users\Administrator\Documents\共振画布\main-3005-isolated"
nodeExe = shell.ExpandEnvironmentStrings("%ProgramFiles%") & "\nodejs\node.exe"
If Not fso.FileExists(nodeExe) Then nodeExe = "node.exe"

command = Chr(34) & nodeExe & Chr(34) & " " & Chr(34) & projectRoot & "\scripts\run-dev-3005.cjs" & Chr(34)
shell.CurrentDirectory = projectRoot

Do
  shell.Run command, 0, True
  WScript.Sleep 5000
Loop
