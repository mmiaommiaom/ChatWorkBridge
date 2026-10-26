[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$Installer,
  [switch]$RunInstallerTests,
  [switch]$IncludeDriveRejectionProbes
)

# This probe is deliberately not part of npm test or build-windows.ps1.
# It runs the supplied installer only when the operator explicitly opts in.
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
if (-not $RunInstallerTests) { throw 'Manual test only. Review this script, then explicitly add -RunInstallerTests to execute the installer rejection probes.' }
$root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if ($root -notmatch '^[A-BD-Za-bd-z]:[\\/]') { throw 'Tests require a local non-C checkout.' }
$installerPath=[IO.Path]::GetFullPath($Installer)
if ($installerPath -notmatch '^[A-BD-Za-bd-z]:[\\/]' -or -not (Test-Path -LiteralPath $installerPath -PathType Leaf)) { throw 'Installer must be an existing local non-C file.' }
foreach ($value in @($root,$installerPath)) {
  $ancestor=$value
  while ($ancestor) {
    if ((Test-Path -LiteralPath $ancestor) -and ((Get-Item -LiteralPath $ancestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Test paths must not traverse reparse points.' }
    $ancestor=[IO.Path]::GetDirectoryName($ancestor)
  }
}
$sandbox=Join-Path (Join-Path $root 'build') ('installer-checks-'+[guid]::NewGuid().ToString('N'))
$temp=Join-Path $sandbox 'temp'
$ancestor=$temp
while ($ancestor) {
  if ((Test-Path -LiteralPath $ancestor) -and ((Get-Item -LiteralPath $ancestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Test output must not traverse reparse points.' }
  $ancestor=[IO.Path]::GetDirectoryName($ancestor)
}
New-Item -ItemType Directory -Path $temp | Out-Null
$marker=Join-Path $sandbox 'unexpected-command-executed.txt'
$results=@()
$oldTemp=$env:TEMP;$oldTmp=$env:TMP
function Test-Rejected([string]$Label,[string]$Target) {
  # Start-Process directly invokes the EXE, never cmd.exe or a shell. /D is
  # intentionally the final NSIS parameter and consumes the entire remainder.
  $process=Start-Process -FilePath $installerPath -ArgumentList ('/S /D='+$Target) -Wait -PassThru
  if ($process.ExitCode -ne 2) { throw "Expected rejection exit 2 for $Label, received $($process.ExitCode). Artifacts are retained at $sandbox" }
  if (Test-Path -LiteralPath $marker) { throw "An injected command ran for $Label" }
  return [pscustomobject]@{label=$Label;rejected=$true;exitCode=$process.ExitCode;injectedCommandExecuted=$false}
}
try {
  $env:TEMP=$temp;$env:TMP=$temp
  $characters=@("'",'"','`','$','%',"`r","`n",';','&','|','<','>','(',')','{','}')
  for ($index=0;$index -lt $characters.Count;$index++) {
    $target=Join-Path $sandbox ('forbidden-'+$index+'-'+$characters[$index]+'-target')
    # Windows/NSIS can normalize filename-invalid characters before the
    # installer receives INSTDIR. Such an argument must still never overwrite
    # an existing normalized destination; do not mistake legal normalization
    # for execution of the original shell character.
    $normalizes=@('"','|','<','>',"`r","`n") -contains $characters[$index]
    if ($normalizes) {
      $normalized=$target.Replace($characters[$index],'')
      New-Item -ItemType Directory -Path $normalized | Out-Null
      $normalizedSentinel=Join-Path $normalized 'keep.txt'
      [IO.File]::WriteAllText($normalizedSentinel,'Keep the normalized destination unchanged.')
      $normalizedHash=(Get-FileHash -LiteralPath $normalizedSentinel -Algorithm SHA256).Hash
      $results+=Test-Rejected ('normalized-existing-destination-'+$index) $target
      if ((Get-FileHash -LiteralPath $normalizedSentinel -Algorithm SHA256).Hash -ne $normalizedHash -or (Test-Path -LiteralPath (Join-Path $normalized 'START.vbs'))) { throw 'Normalized destination was modified.' }
    } else {
      $results+=Test-Rejected ('forbidden-character-'+$index) $target
    }
  }
  $injection=Join-Path $sandbox ("bad';[IO.File]::WriteAllText('"+$marker+"','bad');#")
  $results+=Test-Rejected 'command-injection-data' $injection
  $existing=Join-Path $sandbox 'existing-install'
  New-Item -ItemType Directory -Path (Join-Path $existing 'config') | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $existing 'data') | Out-Null
  $settings=Join-Path $existing 'config/local.json';$sentinel=Join-Path $existing 'data/keep.txt'
  [IO.File]::WriteAllText($settings,'{"synthetic":"preserve"}')
  [IO.File]::WriteAllText($sentinel,'synthetic data must remain unchanged')
  $beforeSettings=(Get-FileHash -LiteralPath $settings -Algorithm SHA256).Hash
  $beforeData=(Get-FileHash -LiteralPath $sentinel -Algorithm SHA256).Hash
  $results+=Test-Rejected 'existing-install-preserved' $existing
  if ((Get-FileHash -LiteralPath $settings -Algorithm SHA256).Hash -ne $beforeSettings -or (Get-FileHash -LiteralPath $sentinel -Algorithm SHA256).Hash -ne $beforeData) { throw 'Existing configuration or data changed.' }
  if ($IncludeDriveRejectionProbes) {
    # Optional negative probes: expected to stop before any destination writes.
    $results+=Test-Rejected 'C-drive-denied' ('C:\ChatWorkBridge-reject-'+[guid]::NewGuid().ToString('N'))
    $results+=Test-Rejected 'UNC-denied' ('\\127.0.0.1\not-contacted\ChatWorkBridge-'+[guid]::NewGuid().ToString('N'))
  }
  $report=Join-Path $sandbox 'rejection-results.json'
  [IO.File]::WriteAllText($report,($results | ConvertTo-Json -Depth 5),[Text.UTF8Encoding]::new($false))
  Write-Host ("Passed {0} explicit installer rejection probes. No application was launched. Report: {1}" -f $results.Count,$report)
}
finally { $env:TEMP=$oldTemp;$env:TMP=$oldTmp }
