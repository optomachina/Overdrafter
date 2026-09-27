#requires -Version 5.1
<#
.SYNOPSIS
Runs at most one admitted prepared native job from an enabled paired session.
.DESCRIPTION
Default-off. Existing task state is reconciliation only; this script never
restarts a native mutation or releases occupancy from journal output.
#>
[CmdletBinding()]
param([switch]$Connect,[switch]$ExecuteOne,[string]$WorkerId,[string]$GatewayUrl,
    [string]$TaskId,[string]$RuntimeAdmissionId,[string]$InputAdmissionId,[long]$TaskRevision,
    [string[]]$InputArtifactIds,[string]$PackageRoot,[string]$OutputRoot,[string]$SourceCommit)
if (-not $Connect -or -not $ExecuteOne) { throw 'Default-off: explicit -Connect and -ExecuteOne are required.' }
$ErrorActionPreference='Stop'; Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'CompanionState.ps1')
. (Join-Path $PSScriptRoot 'CompanionStore.ps1')
. (Join-Path $PSScriptRoot 'CompanionHttp.ps1')
. (Join-Path $PSScriptRoot 'CompanionArtifact.ps1')
. (Join-Path $PSScriptRoot 'CompanionTask.ps1')
. (Join-Path $PSScriptRoot 'CompanionTaskHttp.ps1')
. (Join-Path $PSScriptRoot '../prepared-dimension/WireContract.ps1')
. (Join-Path $PSScriptRoot '../prepared-dimension/WireContractV2.ps1')
. (Join-Path $PSScriptRoot '../attempt-journal/JournalContract.ps1')
$handle=$null; $child=$null; $task=$null; $nativeAttempted=$false; $authorityPath=$null
function Save-TaskText([string]$Path,[string]$Text,$Store) {
    $bytes=[Text.Encoding]::UTF8.GetBytes($Text)
    $file=New-CompanionPrivateFile $Path $Store.sid
    try { $file.Write($bytes,0,$bytes.Length); $file.Flush($true) } finally { $file.Dispose() }
    Assert-CompanionPrivateAcl $Path $Store.sid $false
}
function Save-TaskAuthority([string]$Path,$Fresh,$Claim,$Store) {
    $authority=[pscustomobject]@{schema='overdrafter.companion-task-authority.v1';
        attemptId=$Claim.attemptId;fence=$Claim.fence;deadlineAt=$Claim.deadlineAt;
        leaseExpiresAt=$Fresh.leaseExpiresAt}
    $temporary=$Path+'.'+[Guid]::NewGuid().ToString()+'.pending'
    Save-TaskText $temporary ($authority | ConvertTo-Json -Compress) $Store
    if ([IO.File]::Exists($Path)) {
        Assert-CompanionPrivateAcl $Path $Store.sid $false
        [IO.File]::Replace($temporary,$Path,[NullString]::Value)
    } else { [IO.File]::Move($temporary,$Path) }
    Assert-CompanionPrivateAcl $Path $Store.sid $false
}
function Revoke-TaskAuthority([string]$Path,$Store) {
    $revoked=$Path+'.revoked'
    if (-not [IO.File]::Exists($revoked)) { Save-TaskText $revoked 'authority lost' $Store }
}
try {
    Assert-CompanionWindows; Assert-CompanionId $WorkerId; Assert-CompanionEndpoint $GatewayUrl
    foreach ($value in @($TaskId,$RuntimeAdmissionId,$InputAdmissionId)) { Assert-CompanionId $value }
    Assert-CompanionRevision $TaskRevision
    if ($null -eq $InputArtifactIds -or $InputArtifactIds.Count -ne 3 -or
        (@($InputArtifactIds | Select-Object -Unique)).Count -ne 3) { throw 'Exactly three distinct input artifact IDs are required.' }
    foreach ($value in $InputArtifactIds) { Assert-CompanionId $value }
    $package=Assert-CompanionLocalPath $PackageRoot
    $output=Assert-CompanionLocalPath $OutputRoot
    if ($package.Equals($output,[StringComparison]::OrdinalIgnoreCase) -or
        $package.StartsWith($output.TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase) -or
        $output.StartsWith($package.TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase)) {
        throw 'Package and output roots must be disjoint.'
    }
    if ([IO.Directory]::Exists($package) -or -not [IO.Directory]::Exists($output)) {
        throw 'A fresh package root and existing output root are required.'
    }
    $handle=Open-CompanionStore $WorkerId $false
    # A prior process may still have native work; even a clean-looking journal
    # cannot make a new boot or launch safe. Preserve state for owner recovery.
    $taskPath=Join-Path $handle.root ('task-'+$TaskId+'.dpapi')
    if ([IO.File]::Exists($taskPath)) {
        $prior=Read-CompanionTask $handle $TaskId
        [pscustomobject]@{schema='overdrafter.companion-task-status.v1';taskId=$TaskId;
            phase=$prior.phase;recoveryRequired=$true;nativeExecutionAttempted=$false;
            detail='Prior task state requires reconcile-task.ps1 or owner recovery; no automatic restart.'} | ConvertTo-Json -Compress
        return
    }
    $state=Read-CompanionStore $handle
    if ($state.gatewayUrl -cne $GatewayUrl) { throw 'Stored companion endpoint differs.' }
    $runId=[Guid]::NewGuid().ToString()
    $persistState={param($next) Save-CompanionStore $handle $next}
    $sessionTransport={param($request,$token,$endpoint) Send-CompanionHttp $request $token $endpoint}
    $state=Invoke-CompanionStartup $state $runId $sessionTransport $persistState
    $status=Get-CompanionSession $state $runId $sessionTransport
    if ($status.reason -cne 'enabled' -or -not $status.sessionEligible) {
        [pscustomobject]@{schema='overdrafter.companion-task-status.v1';taskId=$TaskId;
            phase='ineligible';reason=$status.reason;nativeExecutionAttempted=$false} | ConvertTo-Json -Compress
        return
    }
    $task=New-CompanionTask $state $TaskId $RuntimeAdmissionId $InputAdmissionId $TaskRevision
    $persistTask={param($next) Save-CompanionTask $handle $next}
    & $persistTask $task
    $taskTransport={param($request,$token,$endpoint) Send-CompanionTaskHttp $request $token $endpoint}
    $task=Invoke-CompanionTaskClaim $task $state $status $taskTransport $persistTask
    if ($task.phase -ceq 'ineligible') {
        [pscustomobject]@{schema='overdrafter.companion-task-status.v1';taskId=$TaskId;
            phase='ineligible';nativeExecutionAttempted=$false} | ConvertTo-Json -Compress
        return
    }
    $fresh=Assert-CompanionFreshEligibility $task $state $taskTransport
    $claim=$task.receipt
    if ($claim.sessionId -cne $status.sessionId) { throw 'Claim session differs from current paired session.' }
    $job=ConvertFrom-CompanionJson $claim.jobText
    $context=ConvertFrom-CompanionJson $claim.contextText
    Assert-CumulativeBinding $job $context $claim.contextSha256
    if ($job.scope.organizationId -cne $context.scope.organizationId -or
        $job.scope.projectId -cne $context.scope.projectId) { throw 'Job and context scope differ.' }
    $predecessor=$null
    if ($null -ne $context.producer) { $predecessor=$context.producer.attemptId }
    $scope=[pscustomobject][ordered]@{organizationId=$job.scope.organizationId;projectId=$job.scope.projectId;
        workerId=$state.workerId;installationId=$state.installationId;bootId=$state.bootId;
        sessionId=$claim.sessionId;taskId=$TaskId;attemptId=$claim.attemptId;fence=$claim.fence;
        inputSnapshotId=$job.inputSnapshotId;candidateSnapshotId=$job.outputSnapshotId;
        predecessorAttemptId=$predecessor}
    # The OVD-519 server resolves these opaque IDs against the exact attempt;
    # supplied IDs are not paths or worker-selected authority.
    $info=New-Object IO.DirectoryInfo($package)
    $info.Create((New-CompanionAcl $handle.sid $true))
    Assert-CompanionPrivateAcl $package $handle.sid $true
    for ($index=0; $index -lt 3; $index++) {
        $expected=$job.inputFiles[$index]
        $retained=Receive-CompanionStoredInput $handle $state $status $scope $InputArtifactIds[$index] $expected.bytes $expected.sha256
        $target=Join-Path $package $expected.path
        $bytes=[IO.File]::ReadAllBytes($retained)
        Assert-CompanionArtifactBytes $bytes $expected.bytes $expected.sha256 16000000
        $parent=[IO.Path]::GetDirectoryName($target)
        if (-not [IO.Directory]::Exists($parent)) {
            $parentInfo=New-Object IO.DirectoryInfo($parent)
            $parentInfo.Create((New-CompanionAcl $handle.sid $true))
        }
        Assert-CompanionPrivateAcl $parent $handle.sid $true
        $file=New-CompanionPrivateFile $target $handle.sid
        try { $file.Write($bytes,0,$bytes.Length); $file.Flush($true) } finally { $file.Dispose() }
        Assert-CompanionPrivateAcl $target $handle.sid $false
        $renewed=Invoke-CompanionTaskHeartbeat $task $state $taskTransport $persistTask
        if ($renewed.outcome -cne 'renewed') { throw 'Attempt authority ended during input transfer.' }
        $null=Assert-CompanionFreshEligibility $task $state $taskTransport
    }
    # A slow transfer cannot acquire a fresh ten-minute native window.
    $fresh=Assert-CompanionFreshEligibility $task $state $taskTransport
    $binding=[pscustomobject]@{organizationId=$job.scope.organizationId;projectId=$job.scope.projectId;
        workerId=$state.workerId;installationId=$state.installationId;bootId=$state.bootId;
        taskId=$TaskId;attemptId=$claim.attemptId;jobId=$job.jobId;fence=$claim.fence;
        jobSha256=$claim.jobSha256;runtimeAdmissionId=$RuntimeAdmissionId}
    $null=Assert-JournalBinding $binding
    $requestPath=Join-Path $handle.root ('job-'+$claim.attemptId+'.json')
    $contextPath=Join-Path $handle.root ('context-'+$claim.attemptId+'.json')
    $bindingPath=Join-Path $handle.root ('binding-'+$claim.attemptId+'.json')
    Save-TaskText $requestPath $claim.jobText $handle
    Save-TaskText $contextPath $claim.contextText $handle
    Save-TaskText $bindingPath ($binding | ConvertTo-Json -Compress) $handle
    if ([IO.Directory]::Exists((Join-Path $output $claim.attemptId))) { throw 'Existing output attempt requires recovery.' }
    $fresh=Assert-CompanionFreshEligibility $task $state $taskTransport
    $authorityPath=Join-Path $handle.root ('authority-'+$claim.attemptId+'.json')
    Save-TaskAuthority $authorityPath $fresh $claim $handle
    $task.phase='launch_committed'; & $persistTask $task
    $runner=Join-Path $PSScriptRoot '../prepared-dimension/run.ps1'
    $executable=Join-Path $PSHOME 'powershell.exe'
    $arguments='-NoProfile -NonInteractive -File "'+$runner+'" -Execute -RequestPath "'+$requestPath+
        '" -ContextPath "'+$contextPath+'" -PackageRoot "'+$package+'" -OutputRoot "'+$output+
        '" -JournalBindingPath "'+$bindingPath+'" -DeadlineAt "'+$claim.deadlineAt+
        '" -AuthorityPath "'+$authorityPath+'"'
    if ($SourceCommit) {
        if ($SourceCommit -cnotmatch '^[0-9a-f]{40}$') { throw 'Invalid reviewed source commit.' }
        $arguments+=' -SourceCommit '+$SourceCommit
    }
    $child=New-Object Diagnostics.Process
    $child.StartInfo.FileName=$executable; $child.StartInfo.Arguments=$arguments
    $child.StartInfo.UseShellExecute=$false; $child.StartInfo.CreateNoWindow=$true
    $child.StartInfo.RedirectStandardOutput=$true; $child.StartInfo.RedirectStandardError=$true
    $nativeAttempted=$true
    if (-not $child.Start()) { throw 'Prepared runner process did not start.' }
    $stdout=$child.StandardOutput.ReadToEndAsync(); $stderr=$child.StandardError.ReadToEndAsync()
    $task.phase='running'; & $persistTask $task
    $heartbeatFailures=0
    while (-not $child.WaitForExit(10000)) {
        try {
            $renewed=Invoke-CompanionTaskHeartbeat $task $state $taskTransport $persistTask
            $heartbeatFailures=0
            if ($renewed.outcome -ceq 'recovery_required') { Revoke-TaskAuthority $authorityPath $handle; break }
            $fresh=Assert-CompanionFreshEligibility $task $state $taskTransport
            Save-TaskAuthority $authorityPath $fresh $claim $handle
        } catch {
            $heartbeatFailures++
            # Stop new native effects on the first unresolved authority check.
            # The retained heartbeat can be replayed by reconciliation only.
            Revoke-TaskAuthority $authorityPath $handle
            $task.phase='recovery_required'; & $persistTask $task; break
        }
    }
    if (-not $child.HasExited) {
        # Do not terminate or forget an owned child on lost authority. The
        # occupied slot stays held until separately admitted process-stop proof.
        $task.phase='recovery_required'; & $persistTask $task
    } else {
        $null=$stdout.GetAwaiter().GetResult(); $null=$stderr.GetAwaiter().GetResult()
        $attemptRoot=Join-Path $output $claim.attemptId
        $resultPath=Join-Path $attemptRoot 'result.json'
        if ($child.ExitCode -eq 0 -and [IO.File]::Exists($resultPath)) {
            $result=(Read-PreparedJson $resultPath).value
            if ($result.outcome -ceq 'succeeded') {
                $status=Get-CompanionSession $state $runId $sessionTransport
                $roles=@('assembly','target','companion','result','identity','preservation','native')
                $paths=@((Join-Path $result.candidateRoot $result.outputFiles[0].path),
                    (Join-Path $result.candidateRoot $result.outputFiles[1].path),
                    (Join-Path $result.candidateRoot $result.outputFiles[2].path),
                    $resultPath,(Join-Path $attemptRoot 'input-identity.json'),
                    (Join-Path $attemptRoot 'source-preservation.json'),
                    (Join-Path $attemptRoot 'native-dimension.stdout.txt'))
                for ($i=0; $i -lt $roles.Count; $i++) {
                    $info=New-Object IO.FileInfo($paths[$i])
                    if (-not $info.Exists) { throw 'Native output role is missing.' }
                    $hash=Get-PreparedHash $paths[$i]
                    $null=Send-CompanionStoredOutput $handle $state $status $scope $roles[$i] $attemptRoot $paths[$i] $info.Length $hash
                }
            }
        }
        $task.phase='awaiting_stop_admission'; & $persistTask $task
    }
    [pscustomobject]@{schema='overdrafter.companion-task-status.v1';taskId=$TaskId;
        attemptId=$claim.attemptId;fence=$claim.fence;phase=$task.phase;
        runnerExited=$child.HasExited;runnerExitCode=$(if ($child.HasExited) {$child.ExitCode} else {$null});
        nativeExecutionAttempted=$true;stopAdmissionPending=$true;resultEligible=$false} | ConvertTo-Json -Compress
} catch {
    if ($null -ne $authorityPath -and $null -ne $handle) {
        try { Revoke-TaskAuthority $authorityPath $handle } catch { }
    }
    if ($null -ne $task -and $task.phase -cnotin @('ineligible','awaiting_stop_admission')) {
        try { $task.phase='recovery_required'; Save-CompanionTask $handle $task } catch { }
    }
    [pscustomobject]@{schema='overdrafter.companion-task-status.v1';taskId=$TaskId;
        phase='recovery_required';nativeExecutionAttempted=$nativeAttempted;
        stopAdmissionPending=$nativeAttempted;detail='Preserve task, journal and occupancy for exact reconciliation.'} | ConvertTo-Json -Compress
    exit 1
} finally {
    if ($null -ne $child) { $child.Dispose() }
    if ($null -ne $handle -and $null -ne $handle.lock) { $handle.lock.Dispose() }
}
