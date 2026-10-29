; Minimal offline installer. No plug-ins, registry writes, shortcuts,
; uninstaller or recursive deletion are used. First-run launch is opt-in and
; never occurs in silent mode.
Unicode true
RequestExecutionLevel user
SetCompressor zlib
CRCCheck force
Name "ChatWorkBridge ${PRODUCT_VERSION}"
OutFile "${OUTPUT_FILE}"
; An explicit /D=... wins. With no /D, .onInit selects an available non-C drive.
InstallDir ""
BrandingText "ChatWorkBridge — Windows preview"
ShowInstDetails show
VIProductVersion "${VI_VERSION}"
VIAddVersionKey "ProductName" "ChatWorkBridge"
VIAddVersionKey "ProductVersion" "${PRODUCT_VERSION}"
VIAddVersionKey "FileDescription" "ChatWorkBridge offline Windows installer"
VIAddVersionKey "FileVersion" "${PRODUCT_VERSION}"
VIAddVersionKey "LegalCopyright" "Copyright 2026 ChatWorkBridge contributors"
LicenseData "${PAYLOAD_DIR}\LICENSE"
DirText "Choose an EMPTY directory on a local non-C drive, or enter a new directory name. Folders containing files are refused. Chrome and WorkBuddy are not included."
Page license
Page directory
Page instfiles

Function .onInit
  StrCmp "$INSTDIR" "" 0 initialized
  StrCpy $0 "$EXEDIR" 3
  StrCpy $1 "$0" 1
  StrCmp $1 "C" fallback
  StrCpy $1 "$0" 1 1
  StrCmp $1 ":" 0 fallback
  IfFileExists "$0*.*" selected
  fallback:
    StrCpy $0 "D:\"
    IfFileExists "$0*.*" selected
    StrCpy $0 "E:\"
    IfFileExists "$0*.*" selected
    StrCpy $0 "F:\"
    IfFileExists "$0*.*" selected
    ; Leave a non-C suggestion for the directory picker. Silent validation
    ; will refuse it if no such drive exists; explicit /D remains available.
    StrCpy $0 "D:\"
  selected:
    StrCpy $INSTDIR "$0ChatWorkBridge-${PRODUCT_VERSION}"
  initialized:
FunctionEnd

Function ValidateDestination
  ; Path data reaches PowerShell only as one single-quoted parameter to a
  ; fixed script block, after all quote/interpreter metacharacters are refused.
  StrLen $0 "$INSTDIR"
  IntCmp $0 180 0 0 invalid
  StrCpy $1 "$INSTDIR" 1 1
  StrCmp $1 ":" 0 invalid
  StrCpy $1 "$INSTDIR" 1 2
  StrCmp $1 "\" 0 invalid
  StrCpy $1 "$INSTDIR" 1
  StrCmp $1 "C" invalid
  StrCpy $0 0
  scan:
    StrCpy $1 "$INSTDIR" 1 $0
    StrCmp $1 "" checked
    StrCmp $1 "'" invalid
    StrCmp $1 '$\"' invalid
    StrCmp $1 "`" invalid
    StrCmp $1 "$$" invalid
    StrCmp $1 "$\r" invalid
    StrCmp $1 "$\n" invalid
    StrCmp $1 "$\t" invalid
    StrCmp $1 "%" invalid
    StrCmp $1 ";" invalid
    StrCmp $1 "&" invalid
    StrCmp $1 "|" invalid
    StrCmp $1 "<" invalid
    StrCmp $1 ">" invalid
    StrCmp $1 "(" invalid
    StrCmp $1 ")" invalid
    StrCmp $1 "{" invalid
    StrCmp $1 "}" invalid
    IntOp $0 $0 + 1
    Goto scan
  checked:
    ; No destination is inserted into the body of this fixed PowerShell code.
    ; The script only reads paths and attributes, rejecting every reparse-point
    ; ancestor, missing drive, nonempty target, C drive and UNC path.
    ClearErrors
    ExecWait `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -Command "& {param([string]$$p) try{$$p=[IO.Path]::GetFullPath($$p);if($$p-notmatch'^[A-BD-Za-bd-z]:\\[^:]+$$'-or!(Test-Path -LiteralPath ([IO.Path]::GetPathRoot($$p)))){exit 21};$$q=$$p;while($$q){if(Test-Path -LiteralPath $$q){if((Get-Item -LiteralPath $$q -Force -ErrorAction Stop).Attributes-band[IO.FileAttributes]::ReparsePoint){exit 22}};$$q=[IO.Path]::GetDirectoryName($$q)};if(Test-Path -LiteralPath $$p){if(![IO.Directory]::Exists($$p)-or[IO.Directory]::GetFileSystemEntries($$p).Length-ne 0){exit 24}};exit 0}catch{exit 23}} '$INSTDIR'"` $0
    IfErrors validation_failed
    StrCmp $0 "24" occupied
    StrCmp $0 "0" 0 validation_failed
    Return
  occupied:
    SetErrorLevel 2
    MessageBox MB_OK|MB_ICONSTOP "This directory contains files (including hidden files), or is a file. Choose an empty directory or enter a new directory name. Existing files have not been changed." /SD IDOK
    Quit
  validation_failed:
    SetErrorLevel 2
    MessageBox MB_OK|MB_ICONSTOP "Directory validation did not succeed. Read-only PowerShell check returned $0. Check security-software logs if it blocked the check; do not disable protection. No files were extracted." /SD IDOK
    Quit
  invalid:
    SetErrorLevel 2
    MessageBox MB_OK|MB_ICONSTOP "Installation stopped. Select an EMPTY local directory outside C:, without links, quotes or command characters (maximum 180 characters), or enter a new directory name. Your existing files have not been changed." /SD IDOK
    Quit
FunctionEnd

Section "ChatWorkBridge"
  SetOutPath "$EXEDIR"
  DetailPrint "Checking the selected directory (read-only)..."
  Call ValidateDestination
  SetOverwrite off
  ClearErrors
  SetOutPath "$INSTDIR"
  File /r "${PAYLOAD_DIR}\*.*"
  IfErrors failed
  DetailPrint "Installed. Open START.cmd in the selected directory to configure your own apps and sign in."
  SetErrorLevel 0
  IfSilent finished
  MessageBox MB_YESNO|MB_ICONQUESTION "Installation complete. Open the first-run configuration guide now?" IDNO finished
  ExecShell "open" "$INSTDIR\START.vbs"
  Goto finished
  failed:
    SetErrorLevel 3
    MessageBox MB_OK|MB_ICONSTOP "Extraction failed. The new directory is retained for inspection. No cleanup or app launch was performed." /SD IDOK
  finished:
SectionEnd
