#requires -Version 7.0
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$NodeDirectory,
  [Parameter(Mandatory=$true)][string]$MakensisDirectory,
  [string]$NpmCli,
  [string]$Version,
  [string]$OutputDirectory,
  [switch]$Offline
)

Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$projectRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if ($projectRoot -notmatch '^[A-BD-Za-bd-z]:[\\/]') { throw 'Project must be on a local non-C drive.' }
$buildDrive=[IO.Path]::GetPathRoot($projectRoot)

function Assert-NoReparseAncestor([string]$Value) {
  $candidate=[IO.Path]::GetFullPath($Value)
  while ($candidate) {
    if (Test-Path -LiteralPath $candidate) {
      $item=Get-Item -LiteralPath $candidate -Force
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Refusing reparse point: $candidate" }
    }
    $parent=[IO.Path]::GetDirectoryName($candidate)
    if ($parent -eq $candidate) { break }
    $candidate=$parent
  }
}
function Assert-BuildOutput([string]$Value) {
  if ($Value -notmatch '^[A-BD-Za-bd-z]:[\\/]') { throw 'Controlled build paths must be absolute local non-C paths.' }
  $resolved=[IO.Path]::GetFullPath($Value)
  if (-not $resolved.StartsWith($buildDrive,[StringComparison]::OrdinalIgnoreCase)) { throw "All controlled build output must remain on the project drive: $buildDrive" }
  Assert-NoReparseAncestor $resolved
  return $resolved
}
function New-OutputDirectory([string]$Value) {
  $resolved=Assert-BuildOutput $Value
  if (-not (Test-Path -LiteralPath $resolved)) { New-Item -ItemType Directory -Path $resolved | Out-Null }
  return $resolved
}
function Require-File([string]$Value) {
  if ($Value -notmatch '^[A-BD-Za-bd-z]:[\\/]') { throw 'Build input files must use absolute local non-C paths.' }
  $resolved=[IO.Path]::GetFullPath($Value)
  Assert-NoReparseAncestor $resolved
  if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) { throw "Required file missing: $resolved" }
  return $resolved
}
function Copy-PayloadFile([string]$Relative, [string]$DestinationRoot) {
  if ($Relative -match '(^|[\\/])\.\.([\\/]|$)' -or [IO.Path]::IsPathRooted($Relative)) { throw "Unsafe manifest entry: $Relative" }
  if ($Relative -match '^(runtime|data|workspaces|artifacts|logs|node_modules)[\\/]' -or $Relative -match '(^|[\\/])local\.json$') { throw "Private data is forbidden in the payload manifest: $Relative" }
  $source=Require-File (Join-Path $projectRoot $Relative)
  if (-not $source.StartsWith($projectRoot+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw "Manifest entry leaves project: $Relative" }
  $target=Join-Path $DestinationRoot $Relative
  $null=New-OutputDirectory ([IO.Path]::GetDirectoryName($target))
  if (Test-Path -LiteralPath $target) { throw "Payload destination already exists: $Relative" }
  Copy-Item -LiteralPath $source -Destination $target
}
function Get-InstalledPackages([string]$ModulesDirectory) {
  if (-not (Test-Path -LiteralPath $ModulesDirectory -PathType Container)) { return }
  foreach ($child in Get-ChildItem -LiteralPath $ModulesDirectory -Directory -Force) {
    if ($child.Name.StartsWith('.')) { continue }
    $directories=if ($child.Name.StartsWith('@')) { @(Get-ChildItem -LiteralPath $child.FullName -Directory) } else { @($child) }
    foreach ($packageDirectory in $directories) {
      Assert-NoReparseAncestor $packageDirectory.FullName
      $manifestPath=Join-Path $packageDirectory.FullName 'package.json'
      if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { continue }
      $metadata=Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
      $licenseFiles=@(Get-ChildItem -LiteralPath $packageDirectory.FullName -File | Where-Object { $_.Name -match '^(LICENSE|LICENCE|COPYING|COPYRIGHT|NOTICE)([._-]|$)' })
      if ($licenseFiles.Count -eq 0) { throw "Installed package has no root license/notice file: $($metadata.name)" }
      $declared=if ($metadata.PSObject.Properties.Name -contains 'license') { $metadata.license } else { 'See bundled license files' }
      [pscustomobject]@{name=$metadata.name;version=$metadata.version;license=$declared;files=@($licenseFiles | ForEach-Object { $_.FullName.Substring($payload.Length+1).Replace('\','/') })}
      Get-InstalledPackages (Join-Path $packageDirectory.FullName 'node_modules')
    }
  }
}

if ($env:OS -ne 'Windows_NT') { throw 'Build requires Windows.' }
$projectRoot=Assert-BuildOutput $projectRoot
foreach ($toolDirectory in @($NodeDirectory,$MakensisDirectory)) { if ($toolDirectory -notmatch '^[A-BD-Za-bd-z]:[\\/]') { throw 'Tool directories must use absolute local non-C paths.' } }
$nodeRoot=[IO.Path]::GetFullPath($NodeDirectory)
$makensisRoot=[IO.Path]::GetFullPath($MakensisDirectory)
$nodeExe=Require-File (Join-Path $nodeRoot 'node.exe')
$nodeLicense=Require-File (Join-Path $nodeRoot 'LICENSE')
if ((Get-Content -LiteralPath $nodeLicense -Raw) -notmatch 'Node\.js is licensed') { throw 'NodeDirectory must contain the official Node LICENSE, including bundled library notices.' }
$makensis=Require-File (Join-Path $makensisRoot 'makensis.exe')
$nsisLicense=Require-File (Join-Path $makensisRoot 'COPYING')
if (-not $NpmCli) { $NpmCli=Join-Path $nodeRoot 'node_modules/npm/bin/npm-cli.js' }
$npmEntry=Require-File $NpmCli
$projectPackage=Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json
if (-not $Version) { $Version=$projectPackage.version }
if ($Version -notmatch '^([0-9]+)\.([0-9]+)\.([0-9]+)(?:-[0-9A-Za-z.-]+)?$') { throw 'Version must be a semver release or prerelease without build metadata.' }
$versionNumbers=@([int]$Matches[1],[int]$Matches[2],[int]$Matches[3],0)
if (@($versionNumbers | Where-Object { $_ -gt 65535 }).Count -gt 0) { throw 'NSIS version components must be at most 65535.' }
$viVersion=$versionNumbers -join '.'
if ($projectPackage.version -ne $Version) { throw 'Package version must equal the requested release version; update package.json and lockfile before building.' }
$lock=Get-Content -LiteralPath (Join-Path $projectRoot 'package-lock.json') -Raw | ConvertFrom-Json -AsHashtable
if ($lock.version -ne $Version -or $lock.packages[''].version -ne $Version) { throw 'Root package-lock version does not match package.json.' }
$buildRoot=New-OutputDirectory (Join-Path $projectRoot 'build')
$runName=$Version+'-'+(Get-Date -Format 'yyyyMMddHHmmss')+'-'+[guid]::NewGuid().ToString('N').Substring(0,8)
$buildDirectory=New-OutputDirectory (Join-Path $buildRoot $runName)
$payload=New-OutputDirectory (Join-Path $buildDirectory 'ChatWorkBridge')
$tempDirectory=New-OutputDirectory (Join-Path $buildDirectory 'temp')
$nativeHome=New-OutputDirectory (Join-Path $buildDirectory 'native-home')
$appData=New-OutputDirectory (Join-Path $nativeHome 'AppData/Roaming')
$localAppData=New-OutputDirectory (Join-Path $nativeHome 'AppData/Local')
$cache=New-OutputDirectory (Join-Path $buildRoot 'npm-cache')
if (-not $OutputDirectory) { $OutputDirectory=Join-Path (Join-Path $projectRoot 'dist') $Version }
$output=New-OutputDirectory $OutputDirectory
$baseName='ChatWorkBridge-'+$Version+'-windows-x64'
$installerFile=Join-Path $output ($baseName+'-setup.exe')
$portableFile=Join-Path $output ($baseName+'-portable.zip')
$checksumsFile=Join-Path $output 'SHA256SUMS'
$releaseFile=Join-Path $output 'release-manifest.json'
foreach ($file in @($installerFile,$portableFile,$checksumsFile,$releaseFile)) { if (Test-Path -LiteralPath $file) { throw "Release output already exists; choose a new output directory: $file" } }
$userNpmConfig=Join-Path $buildDirectory 'user.npmrc'
$globalNpmConfig=Join-Path $buildDirectory 'global.npmrc'
[IO.File]::WriteAllText($userNpmConfig,'',[Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText($globalNpmConfig,'',[Text.UTF8Encoding]::new($false))
$savedEnvironment=@{}
$buildEnvironment=@{TEMP=$tempDirectory;TMP=$tempDirectory;USERPROFILE=$nativeHome;APPDATA=$appData;LOCALAPPDATA=$localAppData;NSISDIR=$makensisRoot;NSISCONFDIR=$buildDirectory;npm_config_cache=$cache;npm_config_userconfig=$userNpmConfig;npm_config_globalconfig=$globalNpmConfig;PATH=($nodeRoot+';'+$env:PATH)}
try {
  foreach ($name in $buildEnvironment.Keys) { $savedEnvironment[$name]=[Environment]::GetEnvironmentVariable($name,'Process');[Environment]::SetEnvironmentVariable($name,$buildEnvironment[$name],'Process') }
  $runtimeIdentity=& $nodeExe -p "JSON.stringify({version:process.versions.node,platform:process.platform,arch:process.arch})"
  if ($LASTEXITCODE -ne 0) { throw 'Could not execute supplied Node runtime.' }
  $identity=$runtimeIdentity | ConvertFrom-Json
  if ($identity.platform -ne 'win32' -or $identity.arch -ne 'x64' -or [version]$identity.version -lt [version]'22.13.0') { throw 'Node input must be Windows x64 version 22.13.0 or newer.' }
  $payloadManifest=Get-Content -LiteralPath (Join-Path $projectRoot 'packaging/payload-manifest.json') -Raw | ConvertFrom-Json
  foreach ($entry in $payloadManifest.files) { Copy-PayloadFile $entry $payload }
  $payloadNode=New-OutputDirectory (Join-Path $payload 'runtime/node')
  Copy-Item -LiteralPath $nodeExe -Destination (Join-Path $payloadNode 'node.exe')
  Copy-Item -LiteralPath $nodeLicense -Destination (Join-Path $payloadNode 'LICENSE')
  $licenseDirectory=New-OutputDirectory (Join-Path $payload 'docs/licenses')
  Copy-Item -LiteralPath $nsisLicense -Destination (Join-Path $licenseDirectory 'NSIS-COPYING.txt')
  $npmArguments=@($npmEntry,'ci','--omit=dev','--ignore-scripts','--no-audit','--no-fund',('--cache='+$cache),'--registry=https://registry.npmjs.org')
  if ($Offline) { $npmArguments+='--offline' }
  Push-Location $payload
  try { & $nodeExe @npmArguments;if ($LASTEXITCODE -ne 0) { throw "npm ci failed with exit code $LASTEXITCODE; staging has been retained." } }
  finally { Pop-Location }
  if (Test-Path -LiteralPath (Join-Path $payload 'config/local.json')) { throw 'Private local config appeared in payload.' }
  foreach ($directory in @('data','logs','artifacts','workspaces')) { if (Test-Path -LiteralPath (Join-Path $payload $directory)) { throw "Private runtime directory appeared in payload: $directory" } }
  $packages=@(Get-InstalledPackages (Join-Path $payload 'node_modules'))
  if ($packages | Where-Object { $_.name -eq '@electron/asar' }) { throw 'Development-only ASAR tooling must not be shipped in the production payload.' }
  foreach ($required in @('playwright-core','@modelcontextprotocol/sdk','zod')) { if (-not ($packages | Where-Object { $_.name -eq $required })) { throw "Production dependency/license missing: $required" } }
  $componentFile=Join-Path $payload 'THIRD_PARTY_COMPONENTS.json'
  [IO.File]::WriteAllText($componentFile,(@{node=@{version=$identity.version;license='runtime/node/LICENSE'};nsis=@{license='docs/licenses/NSIS-COPYING.txt'};packages=$packages} | ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
  $compilerArguments=@('/NOCONFIG','/INPUTCHARSET','UTF8','/WX','/V3',('/DPRODUCT_VERSION='+$Version),('/DVI_VERSION='+$viVersion),('/DPAYLOAD_DIR='+$payload),('/DOUTPUT_FILE='+$installerFile),(Join-Path $projectRoot 'packaging/installer.nsi'))
  & $makensis @compilerArguments
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $installerFile -PathType Leaf)) { throw 'NSIS compilation failed; no installer was executed.' }
  Compress-Archive -LiteralPath $payload -DestinationPath $portableFile -CompressionLevel Optimal
  $checksumLines=@()
  $artifacts=@()
  foreach ($file in @($installerFile,$portableFile)) { $digest=(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant();$name=[IO.Path]::GetFileName($file);$checksumLines+=$digest+'  '+$name;$artifacts+=@{name=$name;sha256=$digest;bytes=(Get-Item -LiteralPath $file).Length} }
  [IO.File]::WriteAllText($checksumsFile,($checksumLines -join "`n")+"`n",[Text.UTF8Encoding]::new($false))
  $release=@{name='ChatWorkBridge';version=$Version;platform='windows-x64';nodeVersion=$identity.version;nodeSha256=(Get-FileHash -LiteralPath $nodeExe -Algorithm SHA256).Hash.ToLowerInvariant();dependenciesInstalledFromLock=$true;developmentDependenciesIncluded=$false;chromeIncluded=$false;workbuddyIncluded=$false;credentialsIncluded=$false;sourceFiles=$payloadManifest.files;productionPackages=$packages.Count;artifacts=$artifacts}
  [IO.File]::WriteAllText($releaseFile,($release | ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
  Write-Host ('Build complete: '+$output)
  Write-Host 'Installer and portable package were created; no installer or application was launched.'
}
finally {
  foreach ($name in $savedEnvironment.Keys) { [Environment]::SetEnvironmentVariable($name,$savedEnvironment[$name],'Process') }
}
