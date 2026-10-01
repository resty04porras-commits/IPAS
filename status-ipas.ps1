param([string]$ServiceName = "IPAS")
$ErrorActionPreference = "Continue"
$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ProjectRoot

$service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($null -eq $service) {
    Write-Host "Windows Service: NOT INSTALLED"
} else {
    Write-Host "Windows Service: $($service.Status)"
}

$port = "3000"
$publicHost = "iictdasset.lbfinc.org"
if (Test-Path ".env") {
    foreach ($line in Get-Content ".env") {
        if ($line -match '^PORT=(.+)$') { $port = $Matches[1].Trim() }
        if ($line -match '^PUBLIC_HOST=(.+)$') { $publicHost = $Matches[1].Trim() }
    }
}

try {
    $app = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/health" -TimeoutSec 5
    Write-Host "Application: $($app.status.ToUpper())"
    Write-Host "OCR via App: $($app.ocr)"
} catch {
    Write-Host "Application: UNAVAILABLE"
}

try {
    $ocr = Invoke-RestMethod -Uri "http://127.0.0.1:8001/health" -TimeoutSec 5
    Write-Host "OCR Service: $($ocr.status.ToUpper())"
} catch {
    Write-Host "OCR Service: UNAVAILABLE"
}

Write-Host "Access URL: http://${publicHost}:${port}"
