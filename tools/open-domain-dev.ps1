param(
  [string]$Hostname = "iictdasset.lbfinc.org",
  [int]$Port = 3000,
  [string]$Address,
  [switch]$UseLanAddress,
  [string]$Browser = "edge"
)

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

function Resolve-BrowserPath {
  param([string]$RequestedBrowser)

  $browserCandidates = switch ($RequestedBrowser.ToLowerInvariant()) {
    'chrome' {
      @(
        "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
        "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
        'chrome.exe'
      )
    }
    default {
      @(
        "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
        "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
        'msedge.exe',
        "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
        "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
        'chrome.exe'
      )
    }
  }

  foreach ($candidate in $browserCandidates) {
    if ($candidate -like '*.exe' -and $candidate -notmatch '^[A-Za-z]:\\' ) {
      $resolved = Get-Command $candidate -ErrorAction SilentlyContinue
      if ($resolved) {
        return $resolved.Source
      }
      continue
    }

    if (Test-Path $candidate) {
      return $candidate
    }
  }

  throw "Could not find a supported Chromium browser. Install Microsoft Edge or Google Chrome."
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

$browserPath = Resolve-BrowserPath -RequestedBrowser $Browser
$profileDir = Join-Path $env:TEMP 'iictdasset-domain-browser'
$url = if ($Port -eq 80) { "http://$Hostname" } else { "http://$Hostname`:$Port" }
$hostRule = "MAP $Hostname $Address"

New-Item -ItemType Directory -Path $profileDir -Force | Out-Null

Start-Process -FilePath $browserPath -ArgumentList @(
  "--user-data-dir=$profileDir",
  '--new-window',
  "--host-resolver-rules=$hostRule",
  $url
)

Write-Output "Opened $url using host rule '$hostRule'."
