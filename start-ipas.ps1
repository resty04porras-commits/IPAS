param([string]$ServiceName = "IPAS")
$ErrorActionPreference = "Stop"
Start-Service -Name $ServiceName
Get-Service -Name $ServiceName
