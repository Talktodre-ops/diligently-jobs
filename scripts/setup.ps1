# =============================================================================
# Diligently — one-time setup (Windows / PowerShell)
# =============================================================================
# Run from anywhere:  powershell -ExecutionPolicy Bypass -File scripts\setup.ps1
#
# Does three things:
#   1. Copies each .env.example -> .env (only if the .env doesn't exist yet)
#   2. Generates one shared BEARER_TOKEN into backend/.env + diligent/.env
#   3. Downloads the Tectonic binary into backend/tools/ (for CV/PDF rendering)
# It never overwrites an existing .env, so it's safe to re-run.
# =============================================================================

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot   # scripts/ lives under the repo root
Write-Host "Diligently setup - repo root: $root"
Write-Host ""

# 1. Copy .env.example -> .env
$pairs = @(
  @{ ex = "backend\.env.example";            env = "backend\.env" },
  @{ ex = "diligent\.env.example";           env = "diligent\.env" },
  @{ ex = "diligent\src-tauri\.env.example"; env = "diligent\src-tauri\.env" }
)
foreach ($p in $pairs) {
  $exPath  = Join-Path $root $p.ex
  $envPath = Join-Path $root $p.env
  if (Test-Path $envPath) {
    Write-Host "  keep    $($p.env) (already exists)"
  } elseif (Test-Path $exPath) {
    Copy-Item $exPath $envPath
    Write-Host "  created $($p.env)"
  }
}
Write-Host ""

# 2. Generate one shared 64-hex BEARER_TOKEN and write it into both sides
$token = -join ((1..64) | ForEach-Object { '{0:x}' -f (Get-Random -Maximum 16) })
$backendEnv = Join-Path $root "backend\.env"
$webEnv     = Join-Path $root "diligent\.env"
if (Test-Path $backendEnv) {
  (Get-Content $backendEnv) -replace '^BEARER_TOKEN=.*', "BEARER_TOKEN=$token" | Set-Content $backendEnv
}
if (Test-Path $webEnv) {
  (Get-Content $webEnv) -replace '^VITE_BEARER_TOKEN=.*', "VITE_BEARER_TOKEN=$token" | Set-Content $webEnv
}
Write-Host "  generated a shared BEARER_TOKEN (backend/.env + diligent/.env)"
Write-Host ""

# 3. Download Tectonic into backend/tools/
$toolsDir    = Join-Path $root "backend\tools"
$tectonicExe = Join-Path $toolsDir "tectonic.exe"
if (Test-Path $tectonicExe) {
  Write-Host "  keep    backend/tools/tectonic.exe (already present)"
} else {
  try {
    New-Item -ItemType Directory -Force -Path $toolsDir | Out-Null
    $ver = "0.15.0"
    $url = "https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%40$ver/tectonic-$ver-x86_64-pc-windows-msvc.zip"
    $zip = Join-Path $env:TEMP "tectonic-$ver.zip"
    Write-Host "  downloading Tectonic $ver ..."
    Invoke-WebRequest -Uri $url -OutFile $zip
    Expand-Archive -Path $zip -DestinationPath $toolsDir -Force
    Remove-Item $zip -Force -ErrorAction SilentlyContinue
    if (Test-Path $tectonicExe) {
      Write-Host "  installed backend/tools/tectonic.exe"
    } else {
      Write-Host "  WARNING: archive extracted but tectonic.exe not found - install manually (see below)."
    }
  } catch {
    Write-Host "  WARNING: Tectonic download failed: $_"
    Write-Host "           Install it from https://tectonic-typesetting.github.io/ and either put"
    Write-Host "           tectonic.exe in backend/tools/ or set TECTONIC_BIN in backend/.env."
  }
}

Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. Paste your keys into the .env files:"
Write-Host "       backend/.env            -> DATABASE_URL (Postgres) + R2_* (S3 bucket)"
Write-Host "       diligent/src-tauri/.env -> at least one LLM key (OpenAI / DeepSeek / Anthropic)"
Write-Host "                                  and optionally TAVILY_API_KEY (company research)"
Write-Host "  2. Terminal 1:  cd backend    ; cargo run"
Write-Host "  3. Terminal 2:  cd diligent   ; npm install ; npm run tauri dev"
Write-Host ""
