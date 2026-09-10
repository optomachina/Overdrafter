#requires -Version 5.1
<#
.SYNOPSIS
Runs the explicitly admitted worker session companion; never executes CAD.
.DESCRIPTION
Default-off. PairingCode must be a SecureString, for example Read-Host -AsSecureString.
Do not supply a raw secret on a command line, in a transcript or in an environment variable.
Owner enablement remains a separate authenticated application action.
#>
[CmdletBinding()]
param([switch]$Connect,[string]$WorkerId,[string]$GatewayUrl,[Security.SecureString]$PairingCode,
    [ValidateRange(1,5760)][int]$MaxPolls=5760)
if (-not $Connect) { throw 'Default-off: explicit -Connect is required for companion session transport.' }
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'CompanionState.ps1')
. (Join-Path $PSScriptRoot 'CompanionStore.ps1')
. (Join-Path $PSScriptRoot 'CompanionHttp.ps1')
$companionStoreHandle=$null
try {
    Assert-CompanionWindows; Assert-CompanionId $WorkerId; Assert-CompanionEndpoint $GatewayUrl
    if ($null -ne $PairingCode -and $PairingCode.Length -ne 68) { throw 'Invalid pairing code length.' }
    $companionStoreHandle=Open-CompanionStore $WorkerId ($null -ne $PairingCode)
    if ($companionStoreHandle.isNew) {
        $pointer=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($PairingCode)
        try { $state=New-CompanionState $WorkerId $GatewayUrl ([Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)) }
        finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
        Save-CompanionStore $companionStoreHandle $state
    } else {
        if ($null -ne $PairingCode) { throw 'Existing state cannot consume a replacement pairing code.' }
        $state=Read-CompanionStore $companionStoreHandle
        if ($state.gatewayUrl -cne $GatewayUrl) { throw 'Stored companion endpoint differs.' }
    }
    $runId=[Guid]::NewGuid().ToString()
    $clock=[Diagnostics.Stopwatch]::StartNew()
    $persist={param($nextState) Save-CompanionStore $companionStoreHandle $nextState}
    $transport={param($request,$token,$endpoint) Send-CompanionHttp $request $token $endpoint}
    $state=Invoke-CompanionStartup $state $runId $transport $persist
    $lastStatus=$null
    for ($poll=0; $poll -lt $MaxPolls -and $clock.Elapsed.TotalHours -lt 8; $poll++) {
        $status=Get-CompanionSession $state $runId $transport
        $changed=$status | ConvertTo-Json -Compress
        if ($changed -cne $lastStatus) {
            [pscustomobject]@{schema='overdrafter.companion-status.v1';workerId=$WorkerId;bootId=$runId;
                sessionEligible=$status.sessionEligible;reason=$status.reason;expiresAt=$status.expiresAt;
                nativeExecution=$false} | ConvertTo-Json -Compress
            $lastStatus=$changed
        }
        if ($status.reason -cin @('paused','expired','boot_mismatch')) { break }
        if ($poll+1 -lt $MaxPolls -and $clock.Elapsed.TotalHours -lt 8) { Start-Sleep -Seconds 5 }
    }
} catch {
    Write-Error 'Companion stopped. Preserve encrypted state for reconciliation; no native work was started.' -ErrorAction Continue
    exit 1
} finally {
    if ($null -ne $companionStoreHandle -and $null -ne $companionStoreHandle.lock) { $companionStoreHandle.lock.Dispose() }
}
