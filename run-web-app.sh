#!/usr/bin/env bash
#
# IPAS web app launcher for Linux (Proxmox VM).
#
# The npm scripts in package.json use Windows "set VAR=value&&" syntax, which
# does NOTHING on Linux (the vars are silently ignored). Use this script on the
# VM instead. It sets the environment the bash way and starts a single server.
#
# Usage:
#   ./run-web-app.sh            # production mode (serves dist/ build)
#   ./run-web-app.sh dev        # development mode (vite dev server / HMR)
#   PORT=3000 ./run-web-app.sh  # override the port
#
# Env defaults (override by exporting before running):
#   NODE_ENV=production  PORT=3000  BIND_HOST=0.0.0.0  OCR_ENGINE=easyocr
#
set -euo pipefail
cd "$(dirname "$0")"

# --- mode -------------------------------------------------------------------
MODE="${1:-prod}"
if [ "$MODE" = "dev" ]; then
  export NODE_ENV="${NODE_ENV:-development}"
else
  export NODE_ENV="${NODE_ENV:-production}"
fi

# --- config (explicit env wins over .env via dotenv's override:false) -------
export PORT="${PORT:-3000}"
export BIND_HOST="${BIND_HOST:-0.0.0.0}"
export OCR_ENGINE="${OCR_ENGINE:-easyocr}"

# --- kill any stale vite preview / old tsx server on the target port ---------
# "vite preview" serves static files only and breaks all /api/* routes.
# It gets launched by accident via the VSCode NPM Scripts panel → "preview".
STALE_PIDS=$(pgrep -f "vite preview" 2>/dev/null || true)
if [ -n "$STALE_PIDS" ]; then
  echo "Killing stale vite preview process(es): $STALE_PIDS"
  kill $STALE_PIDS 2>/dev/null || true
  sleep 1
fi

# Also kill any tsx server.ts already running on our port (safe to restart)
OLD_TSX=$(pgrep -f "tsx server.ts" 2>/dev/null || true)
if [ -n "$OLD_TSX" ]; then
  echo "Killing old tsx server.ts process(es): $OLD_TSX"
  kill $OLD_TSX 2>/dev/null || true
  sleep 1
fi

# --- pre-flight: warn if the chosen port is still taken by something else ---
if ss -tln 2>/dev/null | grep -q ":${PORT} "; then
  echo "WARNING: port ${PORT} is still in use. Waiting 2 s..."
  sleep 2
  if ss -tln 2>/dev/null | grep -q ":${PORT} "; then
    echo "ERROR: port ${PORT} is held by a root-owned process that cannot be killed."
    echo "       Run 'ss -tlnp | grep :${PORT}' to identify it."
    echo "       Start with a different port: PORT=3001 ./run-web-app.sh"
    exit 1
  fi
fi

echo "Starting IPAS web app  (mode=${NODE_ENV}, port=${PORT}, host=${BIND_HOST})"
exec ./node_modules/.bin/tsx server.ts
