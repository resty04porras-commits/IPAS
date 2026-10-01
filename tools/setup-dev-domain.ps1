param(
  [string]$Hostname = "iictdasset.lbfinc.org",
  [int]$Port = 3000,
  [string]$Address,
  [switch]$UseLanAddress,
  [switch]$SkipFirewall
)

function Test-IsAdministrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Start-ElevatedSetup {
  $scriptPath = $MyInvocation.MyCommand.Path
  $argumentList = @(
    '-ExecutionPolicy', 'Bypass',
    '-File', "`"$scriptPath`"",
    '-Hostname', "`"$Hostname`"",
    '-Port', $Port
  )

  if ($PSBoundParameters.ContainsKey('Address') -and $Address) {
    $argumentList += @('-Address', "`"$Address`"")
  }

  if ($UseLanAddress.IsPresent) {
    $argumentList += '-UseLanAddress'
  }

  if ($SkipFirewall.IsPresent) {
    $argumentList += '-SkipFirewall'
  }

  try {
    Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList $argumentList | Out-Null
    Write-Output 'Administrator approval requested in a new PowerShell window.'
    Write-Output 'After the elevated script finishes, you can start the app with npm run dev.'
    exit 0
  } catch {
    throw 'Administrator access is required to update the hosts file and firewall. Re-run this command from an elevated PowerShell window or use npm run open:domain for a browser-only fallback.'
  }
}

function Get-PrimaryIPv4AddressFromIpConfig {
  $ipconfigOutput = ipconfig | Out-String
  $match = [regex]::Match($ipconfigOutput, 'IPv4 Address[^\:]*:\s*(\d{1,3}(?:\.\d{1,3}){3})')
  if ($match.Success) {
    return $match.Groups[1].Value
  }

  return $null
}

function Get-PrimaryIPv4Address {
  try {
    $configs = Get-NetIPConfiguration | Where-Object {
      $_.IPv4DefaultGateway -ne $null -and $_.IPv4Address.Count -gt 0
    }

    foreach ($config in $configs) {
      foreach ($ipv4 in $config.IPv4Address) {
        if ($ipv4.IPAddress -and
          $ipv4.IPAddress -notlike '127.*' -and
          $ipv4.IPAddress -notlike '169.254.*') {
          return $ipv4.IPAddress
        }
      }
    }

    $fallback = Get-NetIPAddress -AddressFamily IPv4 | Where-Object {
      $_.IPAddress -notlike '127.*' -and
      $_.IPAddress -notlike '169.254.*'
    } | Select-Object -First 1 -ExpandProperty IPAddress

    if ($fallback) {
      return $fallback
    }
  } catch {
  }

  return Get-PrimaryIPv4AddressFromIpConfig
}

if (-not (Test-IsAdministrator)) {
  Start-ElevatedSetup
}

if (-not $Address) {
  if ($UseLanAddress.IsPresent) {
    $Address = Get-PrimaryIPv4Address
  } else {
    $Address = '127.0.0.1'
  }
}

if (-not $Address) {
  throw "Could not determine a usable IPv4 address for this machine."
}

$hostsDirectory = Join-Path $env:SystemRoot 'System32\drivers\etc'
$hostsPath = Join-Path $hostsDirectory 'hosts'
$hostsTemplatePath = Join-Path $hostsDirectory 'hosts.txt'
$backupPath = "$hostsPath.iictd.bak"
$blockStart = '# BEGIN IICTD DOMAIN'
$blockEnd = '# END IICTD DOMAIN'

if (-not (Test-Path $hostsPath)) {
  if (Test-Path $hostsTemplatePath) {
    Copy-Item -LiteralPath $hostsTemplatePath -Destination $hostsPath -Force
  } else {
    Set-Content -LiteralPath $hostsPath -Value @(
      '# Auto-created by setup-dev-domain.ps1'
      '# localhost name resolution is handled within DNS itself.'
      '# 127.0.0.1 localhost'
      '# ::1 localhost'
    ) -Encoding ascii
  }
}

$existingLines = Get-Content -LiteralPath $hostsPath -ErrorAction Stop
$filteredLines = New-Object System.Collections.Generic.List[string]
$insideManagedBlock = $false
$hostnamePattern = '(^|\s)' + [regex]::Escape($Hostname) + '(\s|$)'

foreach ($line in $existingLines) {
  if ($line -eq $blockStart) {
    $insideManagedBlock = $true
    continue
  }

  if ($line -eq $blockEnd) {
    $insideManagedBlock = $false
    continue
  }

  if ($insideManagedBlock) {
    continue
  }

  if ($line -match $hostnamePattern) {
    continue
  }

  [void]$filteredLines.Add($line)
}

if ($filteredLines.Count -gt 0 -and $filteredLines[$filteredLines.Count - 1].Trim() -ne '') {
  [void]$filteredLines.Add('')
}

[void]$filteredLines.Add($blockStart)
[void]$filteredLines.Add("$Address`t$Hostname")
[void]$filteredLines.Add($blockEnd)

Copy-Item -LiteralPath $hostsPath -Destination $backupPath -Force
Set-Content -LiteralPath $hostsPath -Value $filteredLines -Encoding ascii

ipconfig /flushdns | Out-Null

if (-not $SkipFirewall) {
  & "$PSScriptRoot\enable-mobile-backend-firewall.ps1" -Port $Port
}

Write-Output "Mapped $Hostname to $Address in $hostsPath."
Write-Output "Backup saved to $backupPath."
if ($Port -eq 80) {
  Write-Output "Access URL: http://$Hostname"
} else {
  Write-Output "Access URL: http://$Hostname`:$Port"
}
