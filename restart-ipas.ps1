param([string]$ServiceName = "IPAS")
$ErrorActionPreference = "Stop"
Restart-Service -Name $ServiceName
Get-Service -Name $ServiceName
