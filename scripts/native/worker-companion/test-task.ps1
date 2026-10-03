#requires -Version 5.1
# Synthetic transport/state tests only; no network, disk, credentials or CAD.
$ErrorActionPreference='Stop'; Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'CompanionState.ps1')
. (Join-Path $PSScriptRoot 'CompanionTask.ps1')
$script:checks=0
function Check([bool]$Condition,[string]$Label) { $script:checks++; if (-not $Condition) { throw ('Task check failed: '+$Label) } }
function Must-Fail([scriptblock]$Action,[string]$Label) {
    $failed=$false; try { & $Action | Out-Null } catch { $failed=$true }; Check $failed $Label
}
function U([int]$N) { return '56200000-0000-4000-8000-'+$N.ToString('000000000000') }
foreach ($file in @('CompanionTask.ps1','CompanionTaskHttp.ps1','run-task.ps1','reconcile-task.ps1',
    'CompanionOutputReplay.ps1','replay-output.ps1','test-output-replay.ps1',
    'CompanionAuthorityPipe.ps1','CompanionRuntime.ps1','prepare-runtime.ps1','PreparedRunnerBootstrap.ps1','test-runtime.ps1','test-anonymous-pipe.ps1','test-effect-authority.ps1','test-runner-effect-gate.ps1',
    '../prepared-dimension/run.ps1','../attempt-journal/JournalRunner.ps1','../file-admission/OwnedProcess.ps1')) {
    $errors=$null; $tokens=$null
    $null=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot $file),[ref]$tokens,[ref]$errors)
    if (@($errors).Count -ne 0) { throw ('PowerShell parse failed: '+$file) }
}
$ownedSource=Join-Path $PSScriptRoot '../file-admission/OwnedProcess.ps1'
$sha=[Security.Cryptography.SHA256]::Create()
try { $ownedDigest=[BitConverter]::ToString($sha.ComputeHash([IO.File]::ReadAllBytes($ownedSource))).Replace('-','').ToLowerInvariant() }
finally { $sha.Dispose() }
foreach ($consumer in @('../prepared-dimension/run.ps1','../prepared-preview/run.ps1','../session-lifecycle/lifecycle.ps1')) {
    Check ([IO.File]::ReadAllText((Join-Path $PSScriptRoot $consumer)).Contains($ownedDigest)) ('owned helper digest '+$consumer)
}
$state=[pscustomobject]@{schema='overdrafter.worker-companion.v1';workerId=(U 1);installationId=(U 2);
    gatewayUrl='https://example.invalid/functions/v1/engineering-worker';token=('odw_'+('a'*64));
    paired=$true;revision=3;bootId=(U 3);pending=$null}
$status=[pscustomobject]@{sessionEligible=$true;reason='enabled'}
$contextText=('{"snapshotId":"'+(U 8)+'"}')
$contextHash=Get-CompanionTextHash $contextText
$jobText=('{"schema":"overdrafter.prepared-dimension-job.v2","attemptId":"'+(U 9)+
    '","fence":1,"contextSha256":"'+$contextHash+'","inputSnapshotId":"'+(U 8)+'","outputSnapshotId":"'+(U 10)+'"}')
$claimedAt=[DateTimeOffset]::UtcNow.AddSeconds(-1)
$receipt=[pscustomobject]@{outcome='claimed';taskId=(U 4);taskRevision=1;attemptId=(U 9);attemptRevision=0;
    workerId=$state.workerId;installationId=$state.installationId;bootId=$state.bootId;sessionId=(U 11);
    runtimeAdmissionId=(U 5);inputAdmissionId=(U 6);fence=1;jobText=$jobText;jobSha256=(Get-CompanionTextHash $jobText);
    contextText=$contextText;contextSha256=$contextHash;claimedAt=$claimedAt.ToString('yyyy-MM-ddTHH:mm:ss.fffZ');
    deadlineAt=$claimedAt.AddMinutes(10).ToString('yyyy-MM-ddTHH:mm:ss.fffZ');
    leaseExpiresAt=$claimedAt.AddSeconds(60).ToString('yyyy-MM-ddTHH:mm:ss.fffZ')}
$script:saved=$null; $persist={param($next) $script:saved=Copy-CompanionRecord $next}
$script:claims=0
$claimTransport={param($request,$token,$url)
    Check ($request.taskId -ceq (U 4) -and $token -ceq $state.token -and
        $url -ceq 'https://example.invalid/functions/v1/engineering-worker-task') 'exact claim transport'
    $script:claims++
    return [pscustomobject]@{status=200;body=[pscustomobject]@{schema='overdrafter.worker-task.v1';action='claim';receipt=$receipt}}
}
$task=New-CompanionTask $state (U 4) (U 5) (U 6) 0
& $persist $task
$task=Invoke-CompanionTaskClaim $task $state $status $claimTransport $persist
Check ($task.phase -ceq 'claimed' -and $script:claims -eq 1 -and $null -eq $task.pending) 'claim persisted once'
$eligibility={param($request,$token,$url)
    Check ($request.attemptId -ceq (U 9) -and $request.fence -eq 1 -and $request.action -ceq 'eligibility') 'fresh eligibility scope'
    return [pscustomobject]@{status=200;body=[pscustomobject]@{schema='overdrafter.worker-task.v1';action='eligibility';
        receipt=[pscustomobject]@{attemptId=(U 9);fence=1;eligible=$true;reason='eligible';revision=0;
            leaseExpiresAt=$receipt.leaseExpiresAt;deadlineAt=$receipt.deadlineAt}}}
}
Check ((Assert-CompanionFreshEligibility $task $state $eligibility).eligible) 'fresh authority before launch'
$wrong=Copy-CompanionRecord $receipt; $wrong.fence=2
Must-Fail { Assert-CompanionClaimReceipt ([pscustomobject]@{taskId=(U 4);workerId=$state.workerId;bootId=$state.bootId;
    runtimeAdmissionId=(U 5);inputAdmissionId=(U 6);pending=[pscustomobject]@{revision=0}}) $wrong } 'stale fence rejected'
$paused=[pscustomobject]@{sessionEligible=$false;reason='paused'}
Must-Fail { Invoke-CompanionTaskClaim (New-CompanionTask $state (U 4) (U 5) (U 6) 0) $state $paused $claimTransport $persist } 'paused claim denied'
$script:lost=$true
$drop={param($request,$token,$url) if ($script:lost) { $script:lost=$false; throw 'synthetic lost response' }; & $claimTransport $request $token $url}
$unknown=New-CompanionTask $state (U 4) (U 5) (U 6) 0
& $persist $unknown
Must-Fail { Invoke-CompanionTaskClaim $unknown $state $status $drop $persist } 'lost claim stays unknown'
Check ($unknown.phase -ceq 'claim_unknown' -and $script:saved.pending.idempotencyKey -ceq $unknown.pending.idempotencyKey) 'same key retained'
$unknown=Invoke-CompanionTaskClaim $unknown $state $status $drop $persist
Check ($unknown.phase -ceq 'recovery_required' -and $null -eq $unknown.pending) 'replay never grants launch'
$crashed=New-CompanionTask $state (U 4) (U 5) (U 6) 0
$crashed.phase='claim_unknown'; & $persist $crashed
$crashed=Invoke-CompanionTaskClaim $crashed $state $status $claimTransport $persist
Check ($crashed.phase -ceq 'recovery_required') 'crash-retained claim cannot grant launch'
$task.phase='running'; & $persist $task
$script:heartbeatLost=$true; $script:heartbeatKey=$null
$beat={param($request,$token,$url)
    if ($null -eq $script:heartbeatKey) { $script:heartbeatKey=$request.idempotencyKey }
    Check ($request.idempotencyKey -ceq $script:heartbeatKey -and $request.fence -eq 1) 'heartbeat exact replay'
    if ($script:heartbeatLost) { $script:heartbeatLost=$false; throw 'synthetic heartbeat loss' }
    return [pscustomobject]@{status=200;body=[pscustomobject]@{schema='overdrafter.worker-task.v1';action='heartbeat';
        receipt=[pscustomobject]@{outcome='renewed';attemptId=(U 9);fence=1;revision=1;
            leaseExpiresAt=$receipt.leaseExpiresAt;deadlineAt=$receipt.deadlineAt}}}
}
Must-Fail { Invoke-CompanionTaskHeartbeat $task $state $beat $persist } 'lost heartbeat retains request'
Check ($null -ne $task.heartbeat -and $task.receipt.attemptRevision -eq 0) 'heartbeat pending durable'
$task.phase='recovery_required'; & $persist $task
$renewed=Invoke-CompanionTaskHeartbeat $task $state $beat $persist
Check ($renewed.outcome -ceq 'renewed' -and $null -eq $task.heartbeat -and
    $task.receipt.attemptRevision -eq 1 -and $task.phase -ceq 'recovery_required') 'same heartbeat replay cannot resume launch'
Check ((ConvertTo-CompanionObserverDeadline '2026-09-27T11:10:00.123456+02:00') -ceq
    '2026-09-27T09:10:00.123Z') 'observer deadline normalizes offset and floors microseconds'
Must-Fail { ConvertTo-CompanionObserverDeadline 'not-a-time' } 'observer malformed deadline denied'
$script:replaceCalls=0
Invoke-CompanionAuthorityReplacement {
    $script:replaceCalls++
    if ($script:replaceCalls -lt 3) { throw [IO.IOException]::new('synthetic sharing violation') }
}
Check ($script:replaceCalls -eq 3) 'transient replacement succeeds within bound'
$script:replaceCalls=0
Must-Fail { Invoke-CompanionAuthorityReplacement {
    $script:replaceCalls++; throw [IO.IOException]::new('persistent synthetic sharing violation')
} } 'persistent replacement still fails closed'
Check ($script:replaceCalls -eq 5) 'replacement attempt count is finite'
$script:replaceCalls=0
Must-Fail { Invoke-CompanionAuthorityReplacement {
    $script:replaceCalls++; throw [UnauthorizedAccessException]::new('synthetic ACL failure')
} } 'non-sharing failures are not retried'
Check ($script:replaceCalls -eq 1) 'ACL failure receives one attempt'

# Fresh boots lose old enablement. Only a later authenticated exact-boot grant
# may end this bounded wait; the synthetic transport refuses every mutation.
$script:waitMs=0; $script:sessionReads=0; $script:waitingNotices=0
$script:sessionReason='owner_enablement_required'; $script:enableAfter=2; $script:responseDelay=0
$sessionTransport={param($request,$token,$url)
    Check ($request.action -ceq 'session' -and $request.bootId -ceq $state.bootId -and
        $token -ceq $state.token -and $url -ceq $state.gatewayUrl) 'wait uses only exact-boot session read'
    $script:sessionReads++; $script:waitMs+=$script:responseDelay
    $reason=$script:sessionReason
    if ($script:enableAfter -gt 0 -and $script:sessionReads -ge $script:enableAfter) { $reason='enabled' }
    $sessionId=$null; $expiresAt=$null; $bootId=$state.bootId
    if ($reason -cin @('enabled','paused','expired')) { $sessionId=U 11; $expiresAt=$receipt.deadlineAt }
    if ($reason -ceq 'boot_mismatch') { $bootId=U 99 }
    return [pscustomobject]@{status=200;body=[pscustomobject]@{schema='overdrafter.worker-gateway.v1';action='session';
        receipt=[pscustomobject]@{workerId=$state.workerId;installationId=$state.installationId;
            revision=4;bootId=$bootId;sessionId=$sessionId;expiresAt=$expiresAt;
            sessionEligible=($reason -ceq 'enabled');reason=$reason}}}
}
$elapsed={ $script:waitMs }; $delay={param($ms) $script:waitMs+=$ms}
$notice={param($pending) Check (-not $pending.sessionEligible) 'waiting notice cannot grant authority'; $script:waitingNotices++}
$enabled=Wait-CompanionTaskSession $state $state.bootId $sessionTransport 10 $notice $elapsed $delay
Check ($enabled.sessionEligible -and $script:sessionReads -eq 2 -and $script:waitMs -eq 5000 -and
    $script:waitingNotices -eq 1) 'fresh boot waits for explicit later enablement'
$script:waitMs=0; $script:sessionReads=0; $script:enableAfter=0
Check ($null -eq (Wait-CompanionTaskSession $state $state.bootId $sessionTransport 3 $notice $elapsed $delay)) 'unenabled boot times out without authority'
Check ($script:sessionReads -eq 1 -and $script:waitMs -eq 3000) 'timeout caps delay and prohibits another read'
foreach ($reason in @('paused','expired','boot_mismatch')) {
    $script:waitMs=0; $script:sessionReads=0; $script:sessionReason=$reason
    $denied=Wait-CompanionTaskSession $state $state.bootId $sessionTransport 10 $notice $elapsed $delay
    Check (-not $denied.sessionEligible -and $script:sessionReads -eq 1 -and $script:waitMs -eq 0) ('terminal denial does not wait '+$reason)
}
$script:sessionReason='owner_enablement_required'; $script:sessionReads=0
$immediate=Wait-CompanionTaskSession $state $state.bootId $sessionTransport 0 $notice $elapsed $delay
Check (-not $immediate.sessionEligible -and $script:sessionReads -eq 1) 'zero wait keeps immediate probe behavior'
$script:waitMs=0; $script:sessionReads=0; $script:enableAfter=1; $script:responseDelay=10000
Check ($null -eq (Wait-CompanionTaskSession $state $state.bootId $sessionTransport 10 $notice $elapsed $delay)) 'late enabled reply cannot escape wait budget'
Must-Fail { Wait-CompanionTaskSession $state (U 99) $sessionTransport 10 $notice $elapsed $delay } 'foreign boot cannot enter wait'
Must-Fail { Wait-CompanionTaskSession $state $state.bootId { throw 'synthetic transport failure' } 10 $notice $elapsed $delay } 'transport failure cannot grant eligibility'

# Compose real startup, wait and claim helpers. A boot invalidates the old
# synthetic grant; only the separately simulated owner action restores it.
$script:serverBoot=$state.bootId; $script:serverRevision=$state.revision
$script:serverEnabled=$true; $script:bootWrites=0; $script:waitMs=0
$startupTransport={param($request,$token,$url)
    if ($request.action -ceq 'boot') {
        Check ($request.expectedRevision -eq $script:serverRevision) 'fresh boot uses current revision'
        $script:serverBoot=$request.bootId; $script:serverRevision++; $script:serverEnabled=$false; $script:bootWrites++
        $reply=[pscustomobject]@{workerId=$state.workerId;revision=$script:serverRevision;bootId=$script:serverBoot;enabled=$false}
    } else {
        Check ($request.action -ceq 'session') 'startup admits no owner enablement action'
        $reason='owner_enablement_required'; $session=$null; $expires=$null; $eligible=$false
        if ($request.bootId -cne $script:serverBoot) { $reason='boot_mismatch' }
        elseif ($script:serverEnabled) { $reason='enabled'; $eligible=$true; $session=U 11; $expires=$receipt.deadlineAt }
        $reply=[pscustomobject]@{workerId=$state.workerId;revision=$script:serverRevision;
            installationId=$state.installationId;bootId=$script:serverBoot;sessionId=$session;
            sessionEligible=$eligible;reason=$reason;expiresAt=$expires}
    }
    return [pscustomobject]@{status=200;body=[pscustomobject]@{schema='overdrafter.worker-gateway.v1';action=$request.action;receipt=$reply}}
}
$state=Invoke-CompanionStartup $state (U 50) $startupTransport $persist
Check (-not $script:serverEnabled -and $state.bootId -ceq (U 50)) 'fresh task boot cannot inherit old grant'
$ownerDelay={param($ms) $script:waitMs+=$ms; $script:serverEnabled=$true}
$status=Wait-CompanionTaskSession $state $state.bootId $startupTransport 10 $notice $elapsed $ownerDelay
$receipt.bootId=$state.bootId; $claimsBefore=$script:claims
$connectedTask=New-CompanionTask $state (U 4) (U 5) (U 6) 0
$connectedTask=Invoke-CompanionTaskClaim $connectedTask $state $status $claimTransport $persist
Check ($script:bootWrites -eq 1 -and $script:claims -eq ($claimsBefore+1) -and
    $connectedTask.phase -ceq 'claimed' -and $connectedTask.bootId -ceq (U 50)) 'one exact-boot claim after explicit delayed owner enablement'
[pscustomobject]@{schema='overdrafter.companion-task-test.v1';assertions=$script:checks;passed=$true;
    network=$false;disk=$false;nativeActions=0;powershell=$PSVersionTable.PSVersion.ToString()} | ConvertTo-Json
