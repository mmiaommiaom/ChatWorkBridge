Option Explicit
Dim shell, files, root, command, result
Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
root = files.GetParentFolderName(WScript.ScriptFullName)
command = "cmd.exe /d /s /c " & Chr(34) & Chr(34) & root & "\START.cmd" & Chr(34) & " --hidden" & Chr(34)
result = shell.Run(command, 0, True)
If result <> 0 Then
  MsgBox "ChatWorkBridge could not start." & vbCrLf & "Read: " & root & "\logs\start.log" & vbCrLf & "You can also run START.cmd to see the error.", 16, "ChatWorkBridge"
End If
