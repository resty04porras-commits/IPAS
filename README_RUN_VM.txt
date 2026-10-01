============================================================
 IICTD PROCESS AUTOMATION SYSTEM (IPAS) - VM RUN GUIDE
 Published: 2026-06-05 11:01   (to Z:\)
============================================================

This folder contains everything needed to run IPAS on the Proxmox VM:
  - Web application (Express server + built React frontend)
  - OCR service (FastAPI / uvicorn, port 8001)
  - Optional Electron desktop build (in release-build\)

------------------------------------------------------------
 0. PREREQUISITES (install once on the VM)
------------------------------------------------------------
  - Node.js 20+ (https://nodejs.org)   -> provides node & npm
  - Python 3.11  (for the OCR service)
  - (Optional) The Electron desktop build needs nothing extra.

  TIP: copy this whole folder from the share to a LOCAL disk on the
  VM (e.g. C:\IPAS) before running, for best performance and so
  node_modules / .venv are created on fast local storage.

------------------------------------------------------------
 1. CONFIGURE ENVIRONMENT
------------------------------------------------------------
  1) Copy .env.example to .env
         copy .env.example .env
  2) Open .env and set values, especially:
         SESSION_SECRET     = (any long random string)
         PUBLIC_HOST        = your VM hostname or IP (e.g. 192.168.66.74)
         PORT               = 3000
         OCR_SERVICE_URL    = http://127.0.0.1:8001
         GEMINI_API_KEY     = (if AI fallback is used)
     NOTE: .env is NOT included in this package for security.

------------------------------------------------------------
 2. START THE OCR SERVICE (port 8001)
------------------------------------------------------------
  First-time setup (creates the Python virtual environment):
         cd ocr-service
         python -m venv .venv
         .venv\Scripts\pip install -r requirements.txt
         cd ..

  Then start it any time by double-clicking:
         run-ocr-service.bat

  It runs:  python -m uvicorn ocr_api:app --host 127.0.0.1 --port 8001
  Leave this window open while using IPAS.

------------------------------------------------------------
 3. START THE WEB APP (port 3000)
------------------------------------------------------------
  Double-click:
         run-web-app.bat

  On first run it installs Node dependencies automatically
  (node_modules is not shipped), then starts the server.
  Open a browser at:
         http://192.168.66.74:3000

------------------------------------------------------------
 4. (OPTIONAL) ELECTRON DESKTOP APP
------------------------------------------------------------
  If release-build\ is present, the packaged Windows desktop app
  is inside:
         release-build\windows-app\
  Launch the IPAS executable there. (Android APK, if built,
  is under release-build\android-apk\.)

------------------------------------------------------------
 5. PORTS / FIREWALL
------------------------------------------------------------
  - Web app : TCP 3000  (allow inbound for LAN access)
  - OCR API : TCP 8001  (localhost only - no inbound needed)

------------------------------------------------------------
 TROUBLESHOOTING
------------------------------------------------------------
  - "npm not found"      -> install Node.js 20+ and reopen the window.
  - OCR errors           -> confirm run-ocr-service.bat is running and
                            ocr-service\.venv was created (step 2).
  - Export/PDF errors    -> the tools\ and public\ folders must stay
                            next to server.ts (they are included here).
  - Port already in use  -> change PORT in .env (web) and restart.

============================================================
