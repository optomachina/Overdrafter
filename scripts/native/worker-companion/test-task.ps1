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
[pscustomobject]@{schema='overdrafter.companion-task-test.v1';assertions=$script:checks;passed=$true;
    network=$false;disk=$false;nativeActions=0;powershell=$PSVersionTable.PSVersion.ToString()} | ConvertTo-Json
