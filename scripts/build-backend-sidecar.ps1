[CmdletBinding()]
param(
    [switch]$SkipInstall,
    [switch]$Clean
)

$ErrorActionPreference = "Stop"

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$Python = Join-Path $RepoRoot "venv\Scripts\python.exe"
$BinariesDir = Join-Path $RepoRoot "src-tauri\binaries"
$BuildDir = Join-Path $RepoRoot "build\pyinstaller"
$OutputExe = Join-Path $BinariesDir "pulse-backend-x86_64-pc-windows-msvc.exe"

function Remove-InRepoDir {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) {
        return
    }
    $resolved = Resolve-Path -LiteralPath $Path
    $repoPrefix = [string]$RepoRoot
    if (-not ([string]$resolved).StartsWith($repoPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to remove path outside repository: $resolved"
    }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}

if (-not (Test-Path -LiteralPath $Python)) {
    throw "Python venv not found: $Python"
}

if ($Clean) {
    Remove-InRepoDir $BuildDir
    Remove-InRepoDir $BinariesDir
}

New-Item -ItemType Directory -Force -Path $BinariesDir | Out-Null
New-Item -ItemType Directory -Force -Path $BuildDir | Out-Null

if (-not $SkipInstall) {
    & $Python -m pip install -r (Join-Path $RepoRoot "backend\requirements.txt")
    & $Python -m pip install -r (Join-Path $RepoRoot "backend\requirements-build.txt")
}

$pyInstallerArgs = @(
    "-m", "PyInstaller",
    "--noconfirm",
    "--onefile",
    "--clean",
    "--name", "pulse-backend-x86_64-pc-windows-msvc",
    "--distpath", $BinariesDir,
    "--workpath", $BuildDir,
    "--specpath", $BuildDir,
    "--paths", (Join-Path $RepoRoot "backend"),
    "--add-data", ((Join-Path $RepoRoot "frontend") + ";frontend"),
    "--add-data", ((Join-Path $RepoRoot "backend\plugins") + ";plugins"),
    "--hidden-import", "win32timezone",
    "--hidden-import", "uvicorn.logging",
    "--hidden-import", "uvicorn.loops.auto",
    "--hidden-import", "uvicorn.protocols.http.auto",
    "--hidden-import", "uvicorn.protocols.websockets.auto",
    "--hidden-import", "plugins.lan_monitor.plugin",
    "--hidden-import", "plugins.lan_monitor.discovery",
    "--hidden-import", "plugins.lan_monitor.pairing",
    "--hidden-import", "plugins.lan_monitor.reconnect",
    (Join-Path $RepoRoot "backend\main.py")
)

& $Python @pyInstallerArgs

if (-not (Test-Path -LiteralPath $OutputExe)) {
    throw "PyInstaller completed but sidecar executable was not found: $OutputExe"
}

Write-Host "Backend sidecar built: $OutputExe"
