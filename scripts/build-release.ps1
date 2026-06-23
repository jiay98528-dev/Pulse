[CmdletBinding()]
param(
    [switch]$SkipInstall,
    [switch]$SkipSmoke
)

$ErrorActionPreference = "Stop"

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$Python = Join-Path $RepoRoot "venv\Scripts\python.exe"
$SidecarScript = Join-Path $PSScriptRoot "build-backend-sidecar.ps1"

function Invoke-Step {
    param(
        [string]$Name,
        [scriptblock]$Script
    )
    Write-Host ""
    Write-Host "==> $Name"
    & $Script
}

function Assert-File {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) {
        throw "Required file not found: $Path"
    }
}

Assert-File $Python
Assert-File $SidecarScript

Push-Location $RepoRoot
try {
    Invoke-Step "Check frontend app syntax" {
        node --check "frontend/js/app.js"
    }

    Invoke-Step "Check telemetry canvas syntax" {
        node --check "frontend/js/telemetry-canvas.js"
    }

    Invoke-Step "Compile Python backend and store modules" {
        & $Python -m compileall backend store
    }

    Invoke-Step "Check Tauri Rust project" {
        cargo check --manifest-path "src-tauri/Cargo.toml"
    }

    Invoke-Step "Build backend sidecar" {
        if ($SkipInstall) {
            & $SidecarScript -SkipInstall
        } else {
            & $SidecarScript
        }
    }

    Invoke-Step "Build Tauri bundles" {
        cargo tauri build
    }

    if (-not $SkipSmoke -and (Test-Path -LiteralPath (Join-Path $PSScriptRoot "release-smoke.js"))) {
        Invoke-Step "Run release smoke script" {
            node (Join-Path $PSScriptRoot "release-smoke.js")
        }
    } elseif (-not $SkipSmoke) {
        Write-Warning "release-smoke.js not found; skipping smoke script"
    }

    Write-Host ""
    Write-Host "==> Release artifacts"
    $artifactGlobs = @(
        "src-tauri/target/release/pulse.exe",
        "src-tauri/target/release/bundle/msi/*.msi",
        "src-tauri/target/release/bundle/nsis/*.exe"
    )
    foreach ($glob in $artifactGlobs) {
        Get-ChildItem -Path $glob -ErrorAction SilentlyContinue | ForEach-Object {
            $hash = Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName
            Write-Host ($_.FullName)
            Write-Host ("  SHA256 " + $hash.Hash)
        }
    }
} finally {
    Pop-Location
}
