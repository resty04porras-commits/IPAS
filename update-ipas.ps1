param([string]$ServiceName = "IPAS")
$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ProjectRoot

function Invoke-Checked([string]$File, [string[]]$Arguments) {
    & $File @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$File $($Arguments -join ' ') failed with exit code $LASTEXITCODE."
    }
}

Write-Host "Stopping $ServiceName ..."
Stop-Service -Name $ServiceName -ErrorAction SilentlyContinue

Write-Host "Installing/updating dependencies ..."
Invoke-Checked "npm" @("install")
if (-not (Test-Path "node_modules\node-windows")) {
    Invoke-Checked "npm" @("install", "--no-save", "node-windows")
}

Write-Host "Rebuilding production assets ..."
Invoke-Checked "npm" @("run", "build")

Write-Host "Starting $ServiceName ..."
Start-Service -Name $ServiceName

$port = "3000"
if (Test-Path ".env") {
    foreach ($line in Get-Content ".env") {
        if ($line -match '^PORT=(.+)$') { $port = $Matches[1].Trim() }
    }
}

$deadline = (Get-Date).AddSeconds(90)
do {
    try {
        $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/health" -TimeoutSec 5
        Write-Host "Application: $($health.status.ToUpper())"
        Write-Host "OCR via App: $($health.ocr)"
        exit 0
    } catch {
        Start-Sleep -Seconds 2
    }
} while ((Get-Date) -lt $deadline)

throw "IPAS did not pass health check after update."
