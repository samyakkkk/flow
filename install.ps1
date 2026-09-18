# Installs the Flow CLI on Windows:  irm https://raw.githubusercontent.com/samyakkkk/flow/release/install.ps1 | iex
#
# Flow on Windows runs the server and the browser UI and connects to a Brain
# hosted elsewhere (Flow Cloud or another computer). It does not host a Brain:
# the graph database Flow uses has no Windows build.
#
# A Cloud dashboard hands out this installer with its own options, so one paste
# installs Flow and connects it to that Brain:
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/samyakkkk/flow/release/install.ps1))) -Cloud URL -CloudBrain ID -Enrollment CREDENTIAL
param([string]$Cloud = '', [string]$CloudBrain = '', [string]$Enrollment = '')
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue' # Invoke-WebRequest is many times slower with its progress bar.

# Validate options before changing any existing installation.
if ($Cloud -or $CloudBrain -or $Enrollment) {
  if ($Cloud -notmatch '^https://.') { throw 'The Cloud URL must start with https://.' }
  if ($CloudBrain -notmatch '^[A-Za-z0-9-]+$') { throw 'Copy the whole command from your Cloud dashboard: the Brain ID is missing.' }
  if ($Enrollment -notmatch '^[a-f0-9]+$') { throw 'Copy the whole command from your Cloud dashboard: the setup credential is missing.' }
}
if (-not [Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -eq 'ARM64') {
  throw 'The Flow CLI supports Windows x64.'
}
# bsdtar has shipped with Windows since Windows 10 1803.
$tar = Join-Path $env:SystemRoot 'System32\tar.exe'
if (-not (Test-Path $tar)) { throw 'Flow needs Windows 10 version 1803 or newer.' }

# One Flow install per machine. Keep in step with resolveReleaseHome in flow-release.mjs.
$releaseHome = $env:FLOW_RELEASE_HOME
if (-not $releaseHome) { $releaseHome = Join-Path $env:USERPROFILE '.local\share\flow-browser' }
New-Item -ItemType Directory -Force -Path $releaseHome | Out-Null
$releaseHome = (Resolve-Path $releaseHome).Path
$env:FLOW_RELEASE_HOME = $releaseHome

$asset = 'flow-browser-win32-x64.tar.gz'
# The copy attached to a release is pinned to it; the repository copy follows the latest CLI release.
$version = '__FLOW_CLI_VERSION__'
$url = if ($version -match '^[0-9.]+$') { "https://github.com/samyakkkk/flow/releases/download/flow-v$version" }
  else { 'https://github.com/samyakkkk/flow/releases/latest/download' }

$temp = Join-Path $releaseHome ".bootstrap.$([Guid]::NewGuid().ToString('N').Substring(0, 8))"
New-Item -ItemType Directory -Force -Path (Join-Path $temp 'bundle') | Out-Null
try {
  Write-Host 'Downloading the Flow CLI (Node and Git are included)...'
  $archive = Join-Path $temp $asset
  Invoke-WebRequest -UseBasicParsing -Uri "$url/$asset" -OutFile $archive
  $expected = ((Invoke-WebRequest -UseBasicParsing -Uri "$url/$asset.sha256").Content |
    ForEach-Object { if ($_ -is [byte[]]) { [Text.Encoding]::ASCII.GetString($_) } else { $_ } }).Trim().Split()[0].ToLower()
  $actual = (Get-FileHash -Algorithm SHA256 $archive).Hash.ToLower()
  if ($expected -notmatch '^[a-f0-9]{64}$' -or $actual -ne $expected) { throw 'The Flow download did not match its checksum.' }

  & $tar -xzf $archive -C (Join-Path $temp 'bundle')
  if ($LASTEXITCODE -ne 0) { throw 'Could not unpack the Flow CLI.' }
  & (Join-Path $temp 'bundle\runtime\bin\node.exe') --disable-warning=ExperimentalWarning `
    (Join-Path $temp 'bundle\scripts\flow-release.mjs') install-bundle (Join-Path $temp 'bundle') $actual
  if ($LASTEXITCODE -ne 0) { throw 'Flow could not be installed.' }
} finally {
  Remove-Item -Recurse -Force $temp -ErrorAction SilentlyContinue
}

# Windows has no conventional per-user bin folder, so Flow's own goes on PATH.
$bin = Join-Path $releaseHome 'bin'
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not (($userPath -split ';') -contains $bin)) {
  [Environment]::SetEnvironmentVariable('Path', (@($userPath, $bin) | Where-Object { $_ }) -join ';', 'User')
}
if (-not (($env:Path -split ';') -contains $bin)) { $env:Path = "$env:Path;$bin" }

# Connect the Brain the dashboard named. Its credential works once and for ten
# minutes, so it goes through a file in this user's profile and is never printed.
$connected = $null
if ($Cloud) {
  Write-Host "Connecting this computer to $Cloud..."
  $credential = Join-Path $releaseHome ".enrollment.$([Guid]::NewGuid().ToString('N'))"
  try {
    [IO.File]::WriteAllText($credential, $Enrollment)
    & (Join-Path $bin 'flow.cmd') setup --cloud $Cloud --cloud-brain $CloudBrain --enrollment-file $credential --harness detected | Out-Null
    $connected = $LASTEXITCODE -eq 0
  } finally {
    Remove-Item -Force $credential -ErrorAction SilentlyContinue
  }
}

Write-Host ''
Write-Host 'Flow is installed.' -ForegroundColor Green
Write-Host ''
Write-Host 'Start it any time with:'
Write-Host '  flow' -ForegroundColor Cyan -NoNewline; Write-Host '                 open Flow in your browser'
Write-Host '  flow --no-open' -ForegroundColor Cyan -NoNewline; Write-Host '       print the link instead of opening a browser'
Write-Host '  flow status | stop | update | --help' -ForegroundColor DarkGray
Write-Host ''
if ($connected -eq $true) {
  Write-Host "Connected to your team's Brain at $Cloud."
  Write-Host '  Pick the projects to work on in Flow. Agents you run there read that'
  Write-Host '  Brain in every session.'
} elseif ($connected -eq $false) {
  Write-Host "Connecting to $Cloud did not work (see the message above)." -ForegroundColor Yellow
  Write-Host '  The command from the dashboard works once and for ten minutes: copy a new'
  Write-Host '  one and run it again. Flow itself is installed and will be reused.'
  exit 1
} else {
  Write-Host 'Then, in the browser:'
  Write-Host '  1. Connect this computer.'
  Write-Host '  2. Connect to your Brain: enter its address and the email and password'
  Write-Host '     you sign in to it with. Windows connects to a Brain hosted on Flow'
  Write-Host '     Cloud or another computer; it does not host one.'
  Write-Host '  3. Pick the projects to work on. Agents you run in Flow read that Brain'
  Write-Host '     in every session.'
}
Write-Host ''
Write-Host 'New terminals will find ' -NoNewline; Write-Host 'flow' -ForegroundColor Cyan -NoNewline; Write-Host ' on PATH; this one already does.'

# Only open a browser for someone at a terminal, not for a script or an agent.
if ([Environment]::UserInteractive -and -not [Console]::IsOutputRedirected) {
  Write-Host ''
  Write-Host 'Starting Flow...' -ForegroundColor DarkGray
  & (Join-Path $bin 'flow.cmd')
}
