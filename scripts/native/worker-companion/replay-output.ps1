#requires -Version 5.1
# Exact retained output replay. No new boot, claim, native launch or occupancy release.
[CmdletBinding()]
param([switch]$Connect,[switch]$ReplayOutput,[string]$WorkerId,[string]$TaskId,
    [string]$AttemptId,[long]$Fence,[string]$GatewayUrl)
if (-not $Connect -or -not $ReplayOutput) { throw 'Default-off: explicit -Connect and -ReplayOutput are required.' }
$ErrorActionPreference='Stop'; Set-StrictMode -Version Latest
foreach ($module in @('CompanionState','CompanionStore','CompanionHttp','CompanionTask','CompanionArtifact','CompanionOutputReplay')) {
    . (Join-Path $PSScriptRoot ($module+'.ps1'))
}
$handle=$null
try {
    Assert-CompanionWindows; Assert-CompanionEndpoint $GatewayUrl
    foreach ($id in @($WorkerId,$TaskId,$AttemptId)) { Assert-CompanionId $id }
    Assert-CompanionRevision $Fence
    if ($Fence -lt 1) { throw 'An exact positive attempt fence is required.' }
    $handle=Open-CompanionStore $WorkerId $false
    $state=Read-CompanionStore $handle
    $task=Read-CompanionTask $handle $TaskId
    if ($state.gatewayUrl -cne $GatewayUrl -or $task.bootId -cne $state.bootId -or
        $null -eq $task.receipt -or $task.receipt.attemptId -cne $AttemptId -or
        $task.receipt.fence -ne $Fence) { throw 'Requested output replay differs from retained attempt.' }
    $descriptor=Read-CompanionOutputReplay $handle $AttemptId
    $sessionTransport={param($request,$token,$endpoint) Send-CompanionHttp $request $token $endpoint}
    $status=Get-CompanionSession $state $state.bootId $sessionTransport
    $readOutput={param($attempt,$file) Read-CompanionOutputBytes $handle $attempt $file}
    Invoke-CompanionOutputReplay $descriptor $task $state $status $readOutput ${function:Send-CompanionArtifactHttp} | ConvertTo-Json -Compress
} catch {
    [pscustomobject]@{schema='overdrafter.companion-output-replay-status.v1';taskId=$TaskId;
        attemptId=$AttemptId;fence=$Fence;phase='recovery_required';nativeExecutionAttempted=$false;
        resultEligible=$false;stopAdmissionPending=$true;
        detail='Output replay unresolved; preserve descriptor, spools, task state and occupancy.'} | ConvertTo-Json -Compress
    exit 1
} finally { if ($null -ne $handle -and $null -ne $handle.lock) { $handle.lock.Dispose() } }
