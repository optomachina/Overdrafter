#requires -Version 5.1
# Exact request reconciliation only. Never boots, claims a new task or starts CAD.
[CmdletBinding()]
param([switch]$Connect,[string]$WorkerId,[string]$TaskId,[string]$GatewayUrl)
if (-not $Connect) { throw 'Default-off: explicit -Connect is required for task reconciliation.' }
$ErrorActionPreference='Stop'; Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'CompanionState.ps1')
. (Join-Path $PSScriptRoot 'CompanionStore.ps1')
. (Join-Path $PSScriptRoot 'CompanionTask.ps1')
. (Join-Path $PSScriptRoot 'CompanionTaskHttp.ps1')
$handle=$null
try {
    Assert-CompanionWindows; Assert-CompanionId $WorkerId; Assert-CompanionId $TaskId; Assert-CompanionEndpoint $GatewayUrl
    $handle=Open-CompanionStore $WorkerId $false
    $state=Read-CompanionStore $handle
    if ($state.gatewayUrl -cne $GatewayUrl) { throw 'Stored endpoint differs.' }
    $task=Read-CompanionTask $handle $TaskId
    if ($task.bootId -cne $state.bootId) { throw 'Prior boot requires owner recovery; no worker replay.' }
    $persist={param($next) Save-CompanionTask $handle $next}
    $transport={param($request,$token,$endpoint) Send-CompanionTaskHttp $request $token $endpoint}
    if ($task.phase -cin @('claim_pending','claim_unknown')) {
        # A crash can occur after the initial request is durable but before
        # the first send. Replay still cannot grant permission to launch.
        $task.phase='claim_unknown'; & $persist $task
        $status=[pscustomobject]@{reason='reconciliation';sessionEligible=$false}
        $task=Invoke-CompanionTaskClaim $task $state $status $transport $persist
    } elseif ($task.phase -cin @('running','recovery_required') -and $null -ne $task.heartbeat) {
        $null=Invoke-CompanionTaskHeartbeat $task $state $transport $persist
        $task.phase='recovery_required'; & $persist $task
    }
    [pscustomobject]@{schema='overdrafter.companion-task-status.v1';taskId=$TaskId;
        phase=$task.phase;nativeExecutionAttempted=$false;reconciliationOnly=$true;
        detail='No native launch. Qualified process-stop evidence and owner decision are still required.'} | ConvertTo-Json -Compress
} catch {
    [pscustomobject]@{schema='overdrafter.companion-task-status.v1';taskId=$TaskId;
        phase='recovery_required';nativeExecutionAttempted=$false;reconciliationOnly=$true;
        detail='Exact request unresolved; preserve task state and occupancy.'} | ConvertTo-Json -Compress
    exit 1
} finally { if ($null -ne $handle -and $null -ne $handle.lock) { $handle.lock.Dispose() } }
