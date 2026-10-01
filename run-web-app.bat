@echo off
REM ====================================================================
REM  IPAS - Web App launcher (Express + Vite build on port 3000)
REM ====================================================================
cd /d "%~dp0"

if not exist "node_modules" (
    echo Installing dependencies (first run only)...
    call npm install
    if errorlevel 1 (
        echo.
        echo [ERROR] npm install failed. Make sure Node.js 20+ is installed.
        pause
        exit /b 1
    )
)

if not exist ".env" (
    echo.
    echo [NOTE] No .env file found. Copy .env.example to .env and fill in values
    echo        (SESSION_SECRET, OCR settings, etc.) before going to production.
    echo.
)

echo Starting IPAS web app on http://0.0.0.0:3000 ...
call npm run start

echo.
echo Web app stopped.
pause
