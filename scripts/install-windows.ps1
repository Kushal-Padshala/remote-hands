# Remote Hands installer for Windows. No administrator rights are needed.
#
# Open PowerShell (Start menu > type "PowerShell" > Enter) and paste this one line:
#
#   irm https://raw.githubusercontent.com/Kushal-Padshala/remote-hands/main/scripts/install-windows.ps1 | iex
#
# It puts everything in your own user folder (%LOCALAPPDATA%\remote-hands): its own copy of Node.js (so nothing
# on your computer can clash with it), the Remote Hands command line tool, and two small launchers (rh and
# remote-hands) that always use that copy of Node. Then it starts the guided setup. You can run it again at any
# time: that updates everything.

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$ProgressPreference = 'SilentlyContinue'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch { }

# The newest Node releases have what Remote Hands needs built in (node:sqlite without a flag: 22.13 or newer).
$MinNodeMajor = 22
$Package = 'remote-hands-cli'
$Home_ = Join-Path $env:LOCALAPPDATA 'remote-hands'
$NodeDir = Join-Path $Home_ 'node'
$NpmPrefix = Join-Path $Home_ 'npm'
$BinDir = Join-Path $Home_ 'bin'
$NodeExe = Join-Path $NodeDir 'node.exe'
$CliEntry = Join-Path $NpmPrefix 'node_modules\remote-hands-cli\dist\index.js'

function Write-Step([string]$Message) {
    Write-Host ''
    Write-Host "== $Message" -ForegroundColor Cyan
}

function Write-Note([string]$Message) {
    Write-Host "   $Message"
}

# Puts a folder FIRST on the user's PATH for good (this user only) and for this window.
function Add-ToUserPathFirst([string]$Folder) {
    $current = [Environment]::GetEnvironmentVariable('Path', 'User')
    if ($null -eq $current) { $current = '' }
    $parts = @($current.Split(';') | Where-Object { $_ -ne '' -and $_ -ne $Folder })
    [Environment]::SetEnvironmentVariable('Path', ((@($Folder) + $parts) -join ';'), 'User')
    $session = @($env:Path.Split(';') | Where-Object { $_ -ne '' -and $_ -ne $Folder })
    $env:Path = ((@($Folder) + $session) -join ';')
}

# True when this Node.js has what Remote Hands needs built in.
function Test-NodeVersion([string]$Text) {
    if ($Text -match '^v(\d+)\.(\d+)\.') {
        $major = [int]$Matches[1]
        $minor = [int]$Matches[2]
        if ($major -ge 24) { return $true }
        if ($major -eq 23) { return ($minor -ge 4) }
        if ($major -eq 22) { return ($minor -ge 13) }
    }
    return $false
}

function Get-OwnNodeVersion {
    if (-not (Test-Path $NodeExe)) { return '' }
    try { return ((& $NodeExe --version) | Out-String).Trim() } catch { return '' }
}

# Downloads the current long-term-support Node.js (checked against its published checksum) and unpacks it
# in %LOCALAPPDATA%\remote-hands\node. Nothing outside your user folder is touched.
function Install-Node {
    $arch = 'x64'
    if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { $arch = 'arm64' }
    Write-Note 'Looking up the current Node.js release...'
    $releases = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json'
    $pick = $releases | Where-Object { $_.lts -and (Test-NodeVersion $_.version) } | Select-Object -First 1
    if ($null -eq $pick) { throw 'Could not find a suitable Node.js release on nodejs.org.' }
    $version = $pick.version
    $zipName = "node-$version-win-$arch.zip"
    $workDir = Join-Path ([IO.Path]::GetTempPath()) ('remote-hands-node-' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $workDir | Out-Null
    try {
        $zipPath = Join-Path $workDir $zipName
        Write-Note "Downloading Node.js $version (about 30 MB)..."
        Invoke-WebRequest -Uri "https://nodejs.org/dist/$version/$zipName" -OutFile $zipPath -UseBasicParsing
        $sums = (Invoke-WebRequest -Uri "https://nodejs.org/dist/$version/SHASUMS256.txt" -UseBasicParsing).Content
        $line = ($sums -split "`n") | Where-Object { $_ -match [regex]::Escape($zipName) } | Select-Object -First 1
        if ($null -eq $line) { throw 'Could not check the download: its checksum is missing.' }
        $expected = ($line.Trim() -split '\s+')[0].ToLowerInvariant()
        $actual = (Get-FileHash -Path $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($expected -ne $actual) { throw 'The Node.js download did not match its checksum, so it was not installed. Please try again.' }
        $unpacked = Join-Path $workDir 'unpacked'
        Expand-Archive -Path $zipPath -DestinationPath $unpacked -Force
        $inner = Get-ChildItem -Path $unpacked | Select-Object -First 1
        if (Test-Path $NodeDir) { Remove-Item -Recurse -Force $NodeDir }
        New-Item -ItemType Directory -Path (Split-Path $NodeDir) -Force | Out-Null
        Move-Item -Path $inner.FullName -Destination $NodeDir
        Write-Note "Node.js $version installed."
    }
    finally {
        Remove-Item -Recurse -Force $workDir -ErrorAction SilentlyContinue
    }
}

# A launcher that always runs Remote Hands with its own Node.js, whatever else is installed or first on PATH.
# The folders are written with %LOCALAPPDATA%, so the file stays plain ASCII even for a name like "Jose with an accent".
function Write-Launchers {
    New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
    $body = '@echo off' + "`r`n" + '"%LOCALAPPDATA%\remote-hands\node\node.exe" "%LOCALAPPDATA%\remote-hands\npm\node_modules\remote-hands-cli\dist\index.js" %*' + "`r`n"
    foreach ($name in @('rh', 'remote-hands', 'rh-browser')) {
        [IO.File]::WriteAllText((Join-Path $BinDir "$name.cmd"), $body, [Text.Encoding]::ASCII)
    }
}

function Install-RemoteHands {
    Write-Host ''
    Write-Host 'Remote Hands for Windows' -ForegroundColor Green
    Write-Host 'Control your browser by typing what you want done.'

    Write-Step 'Checking this computer'
    if ([Environment]::OSVersion.Version.Major -lt 10) { throw 'Remote Hands needs Windows 10 or newer.' }
    if (-not [Environment]::Is64BitOperatingSystem) { throw 'Remote Hands needs 64-bit Windows.' }
    Write-Note 'Windows 10 or newer: OK'

    Write-Step 'Node.js (a private copy, used only by Remote Hands)'
    $own = Get-OwnNodeVersion
    if (Test-NodeVersion $own) {
        Write-Note "Already installed ($own): OK"
    }
    else {
        Install-Node
        $own = Get-OwnNodeVersion
        if (-not (Test-NodeVersion $own)) { throw 'Node.js was installed but could not be started. Please try again, or ask for help with this message.' }
    }

    Write-Step 'Remote Hands'
    $npmCli = Join-Path $NodeDir 'node_modules\npm\bin\npm-cli.js'
    if (-not (Test-Path $npmCli)) { throw 'npm was not found in the Node.js that was installed.' }
    New-Item -ItemType Directory -Path $NpmPrefix -Force | Out-Null
    Write-Note 'Installing the Remote Hands command line tool...'
    # The folder is given on the command line, so no setting on this computer (a project file, an old npm setup) can redirect it.
    & $NodeExe $npmCli install -g $Package --prefix $NpmPrefix
    if ($LASTEXITCODE -ne 0) { throw 'Installing Remote Hands failed (see the messages above).' }
    if (-not (Test-Path $CliEntry)) { throw "Remote Hands was installed but its program file is missing in $NpmPrefix." }
    Write-Launchers
    Add-ToUserPathFirst $BinDir
    Write-Note 'Installed. The commands rh and remote-hands are ready in new PowerShell windows.'

    Write-Step 'Guided setup (a few questions and one sign-in)'
    Write-Host ''
    # Run directly with the private Node: it does not depend on PATH at all.
    & $NodeExe $CliEntry setup --hud
    if ($LASTEXITCODE -ne 0) {
        Write-Host ''
        Write-Host 'Setup did not finish. Fix what it says above, then run:  rh setup --hud' -ForegroundColor Yellow
        return
    }
    Write-Host ''
    Write-Host 'Setup finished. To check that everything is ready, open a new PowerShell and type:  rh doctor' -ForegroundColor Green
}

try {
    Install-RemoteHands
}
catch {
    Write-Host ''
    Write-Host "Could not finish: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host 'Nothing is broken. You can run the same command again.'
}
