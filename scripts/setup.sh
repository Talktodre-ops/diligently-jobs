#!/usr/bin/env bash
# =============================================================================
# Diligently — one-time setup (macOS / Linux)
# =============================================================================
# Run:  bash scripts/setup.sh
#
# 1. Copies each .env.example -> .env (only if the .env doesn't exist yet)
# 2. Generates one shared BEARER_TOKEN into backend/.env + diligent/.env
# 3. Downloads the Tectonic binary into backend/tools/ (for CV/PDF rendering)
# Safe to re-run: it never overwrites an existing .env.
# =============================================================================
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
echo "Diligently setup - repo root: $ROOT"
echo

copy_env() {
  local ex="$ROOT/$1" env="$ROOT/$2"
  if [ -f "$env" ]; then echo "  keep    $2 (already exists)";
  elif [ -f "$ex" ]; then cp "$ex" "$env"; echo "  created $2"; fi
}
copy_env "backend/.env.example"           "backend/.env"
copy_env "diligent/.env.example"          "diligent/.env"
copy_env "diligent/src-tauri/.env.example" "diligent/src-tauri/.env"
echo

# 2. shared bearer token + fix TECTONIC_BIN for non-Windows
TOKEN="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
BACKEND_ENV="$ROOT/backend/.env"
WEB_ENV="$ROOT/diligent/.env"
if [ -f "$BACKEND_ENV" ]; then
  sed -i.bak "s|^BEARER_TOKEN=.*|BEARER_TOKEN=$TOKEN|" "$BACKEND_ENV"
  sed -i.bak "s|^TECTONIC_BIN=.*|TECTONIC_BIN=tools/tectonic|" "$BACKEND_ENV"
  rm -f "$BACKEND_ENV.bak"
fi
if [ -f "$WEB_ENV" ]; then
  sed -i.bak "s|^VITE_BEARER_TOKEN=.*|VITE_BEARER_TOKEN=$TOKEN|" "$WEB_ENV"
  rm -f "$WEB_ENV.bak"
fi
echo "  generated a shared BEARER_TOKEN (backend/.env + diligent/.env)"
echo

# 3. Tectonic
TOOLS="$ROOT/backend/tools"
TECTONIC="$TOOLS/tectonic"
if [ -x "$TECTONIC" ]; then
  echo "  keep    backend/tools/tectonic (already present)"
else
  VER="0.15.0"
  OS="$(uname -s)"; ARCH="$(uname -m)"
  case "$OS-$ARCH" in
    Linux-x86_64)  ASSET="tectonic-$VER-x86_64-unknown-linux-musl.tar.gz" ;;
    Darwin-x86_64) ASSET="tectonic-$VER-x86_64-apple-darwin.tar.gz" ;;
    Darwin-arm64)  ASSET="tectonic-$VER-aarch64-apple-darwin.tar.gz" ;;
    *)             ASSET="" ;;
  esac
  if [ -z "$ASSET" ]; then
    echo "  WARNING: no prebuilt Tectonic for $OS-$ARCH."
    echo "           Install it from https://tectonic-typesetting.github.io/ and set"
    echo "           TECTONIC_BIN in backend/.env (or put the binary in backend/tools/)."
  else
    mkdir -p "$TOOLS"
    URL="https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%40$VER/$ASSET"
    echo "  downloading Tectonic $VER ..."
    if curl -fsSL "$URL" | tar -xz -C "$TOOLS" tectonic 2>/dev/null; then
      chmod +x "$TECTONIC"
      echo "  installed backend/tools/tectonic"
    else
      echo "  WARNING: Tectonic download failed. Install it yourself and set TECTONIC_BIN in backend/.env."
    fi
  fi
fi

echo
echo "Next steps:"
echo "  1. Paste your keys into the .env files:"
echo "       backend/.env            -> DATABASE_URL (Postgres) + R2_* (S3 bucket)"
echo "       diligent/src-tauri/.env -> at least one LLM key (OpenAI/DeepSeek/Anthropic) + optional TAVILY_API_KEY"
echo "  2. Terminal 1:  cd backend  && cargo run"
echo "  3. Terminal 2:  cd diligent && npm install && npm run tauri dev"
echo
