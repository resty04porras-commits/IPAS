param(
    [string]$ServiceName = "IPAS"
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ProjectRoot

function Write-Step([string]$Message) {
    Write-Host ""
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Assert-Admin {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw "Run this script from an Administrator PowerShell window."
    }
}

function Read-DotEnv {
    $values = @{}
    $envPath = Join-Path $ProjectRoot ".env"
    if (-not (Test-Path $envPath)) { return $values }
    foreach ($line in Get-Content $envPath) {
        if ($line -match '^\s*#' -or $line -notmatch '=') { continue }
        $parts = $line -split '=', 2
        $values[$parts[0].Trim()] = $parts[1].Trim()
    }
    return $values
}

function Invoke-Checked([string]$File, [string[]]$Arguments) {
    & $File @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$File $($Arguments -join ' ') failed with exit code $LASTEXITCODE."
    }
}

function Wait-JsonHealth([string]$Url, [int]$Seconds = 90) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    do {
        try {
            return Invoke-RestMethod -Uri $Url -TimeoutSec 5
        } catch {
            Start-Sleep -Seconds 2
        }
    } while ((Get-Date) -lt $deadline)
    throw "Health check timed out: $Url"
}

Assert-Admin

Write-Step "Validating Node.js and npm"
Invoke-Checked "node" @("--version")
Invoke-Checked "npm" @("--version")

if (-not (Test-Path ".env")) {
    Copy-Item ".env.example" ".env"
    Write-Warning ".env was created from .env.example. Fill in secrets before using IPAS with real users."
}

$envValues = Read-DotEnv
if (-not $envValues.ContainsKey("SESSION_SECRET") -or [string]::IsNullOrWhiteSpace($envValues["SESSION_SECRET"])) {
    throw "SESSION_SECRET is required. Generate one with: powershell -NoProfile -Command `"[Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(48))`""
}

Write-Step "Validating OCR Python environment"
$ocrPython = Join-Path $ProjectRoot "ocr-service\.venv\Scripts\python.exe"
if (-not (Test-Path $ocrPython)) {
    Invoke-Checked "python" @("-m", "venv", "ocr-service\.venv")
    $ocrPython = Join-Path $ProjectRoot "ocr-service\.venv\Scripts\python.exe"
    Invoke-Checked $ocrPython @("-m", "pip", "install", "-r", "ocr-service\requirements.txt")
} else {
    Invoke-Checked $ocrPython @("--version")
}

Write-Step "Installing Node dependencies"
Invoke-Checked "npm" @("install")

Write-Step "Building IPAS production assets"
Invoke-Checked "npm" @("run", "build")

Write-Step "Preparing Windows service wrapper"
if (-not (Test-Path "node_modules\node-windows")) {
    Invoke-Checked "npm" @("install", "--no-save", "node-windows")
}
Invoke-Checked "node" @("tools\windows-service\install-service.mjs", $ServiceName)

Write-Step "Configuring service restart policy"
& sc.exe config $ServiceName start= auto | Out-Host
& sc.exe failure $ServiceName reset= 86400 actions= restart/60000/restart/60000/restart/60000 | Out-Host
& sc.exe failureflag $ServiceName 1 | Out-Host

Write-Step "Starting service"
Start-Service -Name $ServiceName

$port = if ($envValues.ContainsKey("PORT") -and $envValues["PORT"]) { $envValues["PORT"] } else { "3000" }
$hostName = if ($envValues.ContainsKey("PUBLIC_HOST") -and $envValues["PUBLIC_HOST"]) { $envValues["PUBLIC_HOST"] } else { "iictdasset.lbfinc.org" }
$accessUrl = "http://${hostName}:${port}"
$appHealth = Wait-JsonHealth "http://127.0.0.1:${port}/api/health" 120
$ocrHealth = Wait-JsonHealth "http://127.0.0.1:8001/health" 120
$service = Get-Service -Name $ServiceName

Write-Host ""
Write-Host "IPAS Production Deployment"
Write-Host "--------------------------"
Write-Host "Application: $($appHealth.status.ToUpper())"
Write-Host "OCR Service: $($ocrHealth.status.ToUpper())"
Write-Host "Windows Service: $($service.Status)"
Write-Host "Startup Type: AUTOMATIC"
Write-Host ""
Write-Host "Access URL:"
Write-Host $accessUrl
