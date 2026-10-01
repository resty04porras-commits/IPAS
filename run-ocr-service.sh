#!/usr/bin/env bash
#
# IPAS OCR service launcher for Linux (Proxmox VM).
# Starts the FastAPI/uvicorn OCR backend on 127.0.0.1:8001 using the venv in
# ocr-service/.venv. The web app talks to this via OCR_SERVICE_URL in .env.
#
# First-time setup (run once):
#   cd ocr-service && python3 -m venv .venv
#   .venv/bin/pip install -r requirements.txt && cd ..
#
set -euo pipefail
cd "$(dirname "$0")/ocr-service"

if [ ! -x .venv/bin/python ]; then
  echo "ERROR: ocr-service/.venv not found. Create it first:" >&2
  echo "  cd ocr-service && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt" >&2
  exit 1
fi

echo "Starting OCR service on http://127.0.0.1:8001"
exec .venv/bin/python -m uvicorn ocr_api:app --host 127.0.0.1 --port 8001
