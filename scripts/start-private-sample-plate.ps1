param(
  [Parameter(Mandatory=$true)][string]$OutputRoot,
  [Parameter(Mandatory=$true)][string]$ExpectedDns,
  [Parameter(Mandatory=$true)][string]$ExpectedUserId
)
$ErrorActionPreference = 'Stop'
$tailscalePath = 'C:\Program Files\Tailscale\tailscale.exe'
$state = (& $tailscalePath status --json | ConvertFrom-Json)
if ($LASTEXITCODE -ne 0 -or $state.BackendState -ne 'Running' -or -not $state.Self.Online) { throw 'Existing Tailscale identity must be online' }
if ($state.Self.DNSName.TrimEnd('.') -ne $ExpectedDns -or [string]$state.Self.UserID -ne $ExpectedUserId) { throw 'Retained Tailscale identity changed' }
if ($state.CertDomains -notcontains $ExpectedDns) { throw 'Existing HTTPS certificate domain required' }
$identity = $state.User.PSObject.Properties[$ExpectedUserId].Value.LoginName
if (-not $identity) { throw 'Existing user identity unavailable' }
if (Get-NetTCPConnection -State Listen -LocalPort 8092 -ErrorAction SilentlyContinue) { throw 'Private sample port already owned' }
$pairingParent = Join-Path $env:LOCALAPPDATA 'OverDrafter\sample-plate-phone'
New-Item -ItemType Directory -Path $pairingParent -Force | Out-Null
$pairingRoot = Join-Path $pairingParent ([guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $pairingRoot -ErrorAction Stop | Out-Null
$owner = [Security.Principal.WindowsIdentity]::GetCurrent().Name
& icacls.exe $pairingRoot /inheritance:r /grant:r "${owner}:(OI)(CI)F" 'SYSTEM:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Cannot protect private pairing directory' }
$env:OVD_PHONE_ORIGIN = "https://$ExpectedDns"
$env:OVD_PHONE_IDENTITY = $identity
$env:OVD_PHONE_PAIRING_ROOT = $pairingRoot
$env:OVD_SAMPLE_OUTPUT_ROOT = [IO.Path]::GetFullPath($OutputRoot)
Set-Location -LiteralPath (Split-Path $PSScriptRoot -Parent)
Write-Output "Private pairing files will be saved in $pairingRoot. Keep their contents private."
& npm.cmd run serve:sample-plate
