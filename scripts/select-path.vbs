Option Explicit
Dim field, shell, selection, title, flags
If WScript.Arguments.Count <> 1 Then WScript.Quit 2
field = WScript.Arguments(0)
Select Case field
  Case "chromeExe"
    title = "Select installed Chrome (chrome.exe)"
    flags = &H4000 Or &H40 Or &H10 Or &H200
  Case "workbuddyExe"
    title = "Select installed WorkBuddy (WorkBuddyAI.exe or WorkBuddy.exe)"
    flags = &H4000 Or &H40 Or &H10 Or &H200
  Case "workbuddyProfile"
    title = "Select existing WorkBuddy user profile or configuration folder"
    flags = &H40 Or &H10 Or &H200
  Case "check"
    Set shell = CreateObject("Shell.Application")
    WScript.StdOut.WriteLine "available"
    WScript.Quit 0
  Case Else
    WScript.Quit 2
End Select
Set shell = CreateObject("Shell.Application")
Set selection = shell.BrowseForFolder(0, title, flags, 0)
If selection Is Nothing Then
  WScript.StdOut.WriteLine ""
Else
  WScript.StdOut.WriteLine selection.Self.Path
End If
