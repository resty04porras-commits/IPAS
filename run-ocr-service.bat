@echo off
REM ====================================================================
REM  IPAS - OCR Service launcher (FastAPI / uvicorn on port 8001)
REM ====================================================================
cd /d "%~dp0ocr-service"

REM Prefer the local virtual environment if it has been created on the VM.
if exist ".venv\Scripts\python.exe" (
    echo Using virtual environment .venv ...
    ".venv\Scripts\python.exe" -m uvicorn ocr_api:app --host 127.0.0.1 --port 8001
) else (
    echo .venv not found - using system Python.
    echo   ( First-time setup:  python -m venv .venv ^&^& .venv\Scripts\pip install -r requirements.txt )
    python -m uvicorn ocr_api:app --host 127.0.0.1 --port 8001
)

echo.
echo OCR service stopped.
pause
