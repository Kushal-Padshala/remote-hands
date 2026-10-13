# Remote Hands installer for Windows. No administrator rights are needed.
#
# Open PowerShell (Start menu > type "PowerShell" > Enter) and paste this one line:
#
#   irm https://raw.githubusercontent.com/Kushal-Padshala/remote-hands/main/scripts/install-windows.ps1 | iex
#
# It installs Node.js for you if it is missing (into your own user folder), installs the Remote Hands
# command line tool, and then starts its guided setup. You can run it again at any time.

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$ProgressPreference = 'SilentlyContinue'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch { }

$MinNodeMajor = 22
$Package = 'remote-hands-cli'

function Write-Step([string]$Message) {
    Write-Host ''
    Write-Host "== $Message" -ForegroundColor Cyan
}

function Write-Note([string]$Message) {
    Write-Host "   $Message"
}

# Puts a folder on the user's PATH for good (this user only) and for this window.
function Add-ToUserPath([string]$Folder) {
    $current = [Environment]::GetEnvironmentVariable('Path', 'User')
    if ($null -eq $current) { $current = '' }
    $parts = @($current.Split(';') | Where-Object { $_ -ne '' })
    if ($parts -notcontains $Folder) {
        [Environment]::SetEnvironmentVariable('Path', ((@($parts) + $Folder) -join ';'), 'User')
    }
    if ((@($env:Path.Split(';'))) -notcontains $Folder) {
        $env:Path = "$Folder;$env:Path"
    }
}

function Get-NodeMajor {
    $node = Get-Command node -ErrorAction SilentlyContinue
    if ($null -eq $node) { return 0 }
    try { $version = (& $node.Source --version) } catch { return 0 }
    if ($version -match '^v(\d+)\.') { return [int]$Matches[1] }
    return 0
}

# Downloads the current long-term-support Node.js (checked against its published checksum) and unpacks it
# in %LOCALAPPDATA%\remote-hands\node. Nothing outside your user folder is touched.
function Install-Node {
    $arch = 'x64'
    if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { $arch = 'arm64' }
    Write-Note 'Looking up the current Node.js release...'
    $releases = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json'
    $pick = $releases | Where-Object { $_.lts -and ([int]($_.version.TrimStart('v').Split('.')[0]) -ge $MinNodeMajor) } | Select-Object -First 1
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
        $target = Join-Path $env:LOCALAPPDATA 'remote-hands\node'
        if (Test-Path $target) { Remove-Item -Recurse -Force $target }
        New-Item -ItemType Directory -Path (Split-Path $target) -Force | Out-Null
        Move-Item -Path $inner.FullName -Destination $target
        Add-ToUserPath $target
        Write-Note "Node.js $version installed."
    }
    finally {
        Remove-Item -Recurse -Force $workDir -ErrorAction SilentlyContinue
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

    Write-Step 'Node.js'
    $major = Get-NodeMajor
    if ($major -ge $MinNodeMajor) {
        Write-Note "Node.js $major is installed: OK"
    }
    else {
        if ($major -gt 0) { Write-Note "Your Node.js (version $major) is too old: installing a current one next to it." }
        Install-Node
        if ((Get-NodeMajor) -lt $MinNodeMajor) { throw 'Node.js was installed but could not be started. Please close this window, open a new PowerShell and run the command again.' }
    }

    Write-Step 'Remote Hands'
    $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if ($null -eq $npm) { $npm = Get-Command npm -ErrorAction SilentlyContinue }
    if ($null -eq $npm) { throw 'npm was not found next to Node.js.' }
    Write-Note 'Installing the Remote Hands command line tool...'
    & $npm.Source install -g $Package
    if ($LASTEXITCODE -ne 0) { throw 'Installing Remote Hands failed (see the messages above).' }
    $prefix = (& $npm.Source config get prefix).Trim()
    Add-ToUserPath $prefix
    # PowerShell would pick npm's .ps1 launcher, which a default Windows setting blocks. The .cmd launchers work everywhere.
    foreach ($name in @('rh', 'remote-hands', 'rh-browser')) {
        Remove-Item -Path (Join-Path $prefix "$name.ps1") -Force -ErrorAction SilentlyContinue
    }
    $rh = Join-Path $prefix 'rh.cmd'
    if (-not (Test-Path $rh)) { throw "The rh command was not created in $prefix." }
    Write-Note 'Installed.'

    Write-Step 'Guided setup (a few questions and one sign-in)'
    Write-Host ''
    & $rh setup --hud
    if ($LASTEXITCODE -ne 0) {
        Write-Host ''
        Write-Host 'Setup did not finish. Fix what it says above, then run:  rh setup --hud' -ForegroundColor Yellow
        return
    }
    Write-Host ''
    Write-Host 'All done. To check on things later, open PowerShell and type:  rh doctor' -ForegroundColor Green
}

try {
    Install-RemoteHands
}
catch {
    Write-Host ''
    Write-Host "Could not finish: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host 'Nothing is broken. You can run the same command again.'
}
