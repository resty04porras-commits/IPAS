param([string]$ServiceName = "IPAS")
$ErrorActionPreference = "Stop"
Stop-Service -Name $ServiceName
Get-Service -Name $ServiceName
