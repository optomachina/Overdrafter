#requires -Version 5.1
<#
.SYNOPSIS
Interrupts one synthetic native open/save pre-notification callback.
.DESCRIPTION
One synthetic case, no retries. The controller retains its started worker and
captures verified helper and native descendants before interrupting the worker. It never
terminates by process name, rewrites the old journal or grants server authority.
All files and failure evidence remain available for reconciliation.
#>
[CmdletBinding()]
param(
    [switch]$QualifyNativeCall,
    [Parameter(Mandatory=$true)][ValidateSet('open_call','part_save_call','assembly_save_call')][string]$Boundary,
    [Parameter(Mandatory=$true)][string]$PackageRoot,
    [Parameter(Mandatory=$true)][string]$OutputRoot,
    [Parameter(Mandatory=$true)][string]$OrganizationId,
    [Parameter(Mandatory=$true)][string]$ProjectId,
    [Parameter(Mandatory=$true)][string]$SourceCommit
)
if (-not $QualifyNativeCall) { throw 'Explicit -QualifyNativeCall is required for one synthetic interruption.' }
$ErrorActionPreference='Stop'; Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot '../prepared-dimension/WireContract.ps1')
. (Join-Path $PSScriptRoot '../prepared-dimension/WireContractV2.ps1')
. (Join-Path $PSScriptRoot '../file-admission/OwnedProcess.ps1')
. (Join-Path $PSScriptRoot 'JournalRunner.ps1')
. (Join-Path $PSScriptRoot 'QualificationCheckpoint.ps1')
. (Join-Path $PSScriptRoot 'QualificationEvidence.ps1')
. (Join-Path $PSScriptRoot 'NativeCallController.ps1')
. (Join-Path $PSScriptRoot 'NativeCallEvidence.ps1')
Assert-CompanionWindows
Assert-CumulativeUuid $OrganizationId; Assert-CumulativeUuid $ProjectId
if ($SourceCommit -cnotmatch '^[0-9a-f]{40}\z') { throw 'An exact qualification source commit is required.' }
$source=Resolve-PreparedLocalPath $PackageRoot; $root=Resolve-PreparedLocalPath $OutputRoot
if ($root.Length -gt 45 -or (Test-Path -LiteralPath $root)) { throw 'Use a fresh qualification root of at most 45 characters.' }
if ($root.Equals($source,[StringComparison]::OrdinalIgnoreCase) -or
    $root.StartsWith($source.TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase) -or
    $source.StartsWith($root.TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Qualification and source must be disjoint.' }
$files=Measure-PreparedPackage $source -RequireOriginal
# Enumeration errors are failures, never an empty inventory.
$inventory=@(Get-Process -ErrorAction Stop)
try { if (@($inventory | Where-Object {$_.ProcessName -ieq 'SLDWORKS'}).Count -ne 0) { throw 'Existing native processes prevent qualification.' } }
finally { foreach ($process in $inventory) { $process.Dispose() } }
New-Item -ItemType Directory -Path $root -ErrorAction Stop | Out-Null
$scope=@{organizationId=$OrganizationId;projectId=$ProjectId}; $snapshot=[Guid]::NewGuid().ToString()
$context=[ordered]@{schema='overdrafter.prepared-assembly.v2';packageId='ovd-native04-assembly';scope=$scope;
    snapshotId=$snapshot;seedSnapshotId=$snapshot;sequence=0;producer=$null;createdAt=[DateTime]::UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'");
    configuration='Default';assemblyPath='synthetic-assembly.SLDASM';files=$files;depthMm=5;checks=@()}
$contextPath=Join-Path $root 'context.json'; $contextHash=Write-PreparedJson $contextPath $context
$job=[ordered]@{schema='overdrafter.prepared-dimension-job.v2';scope=$scope;jobId=[Guid]::NewGuid().ToString();attemptId=[Guid]::NewGuid().ToString();
    fence=1;inputSnapshotId=$snapshot;outputSnapshotId=[Guid]::NewGuid().ToString();seedSnapshotId=$snapshot;sequence=1;
    contextSha256=$contextHash;inputFiles=$files;expectedDepthMm=5;dimensionId='baseline-depth';depthMm=8;configuration='Default';
    createdAt=[DateTime]::UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'");requiredChecks=$PreparedChecks}
$jobPath=Join-Path $root 'job.json'; $jobHash=Write-PreparedJson $jobPath $job
# Validate the exact serialized request given to the worker. The construction
# dictionary is not a wire object; preserve timestamp strings on Core as well.
$job=ConvertFrom-CompanionJson ([Text.Encoding]::UTF8.GetString((Read-PreparedJson $jobPath).bytes))
$binding=[pscustomobject]@{organizationId=$OrganizationId;projectId=$ProjectId;workerId=[Guid]::NewGuid().ToString();
    installationId=[Guid]::NewGuid().ToString();bootId=[Guid]::NewGuid().ToString();taskId=[Guid]::NewGuid().ToString();
    jobId=$job.jobId;attemptId=$job.attemptId;fence=1;jobSha256=$jobHash;runtimeAdmissionId=[Guid]::NewGuid().ToString()}
$bindingPath=Join-Path $root 'journal-binding.json'; [void](Write-PreparedJson $bindingPath $binding)
Assert-PreparedQualificationScope (Read-PreparedJson $jobPath).value $binding $SourceCommit
$attempt=Join-Path $root $job.attemptId
$checkpointPath=Join-Path $attempt 'native-call-entered.json'
$releasedPath=Join-Path $attempt 'native-call-released.json'
$executable=Join-Path $PSHOME 'powershell.exe'
$state=New-NativeCallControllerState
$captureState=[pscustomobject]@{checkpoint=$null;cipherSha256=$null;controllerError=$null}
$local=[Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
$journalPath=Join-Path $local ('OverDrafter\NativeAttempts\'+$binding.workerId+'\Attempts\'+$binding.attemptId+'\journal.dpapi')
$oldDirectory=[Environment]::CurrentDirectory; $observation=$null; $errorMessage=$null; $summary=$null; $reader=$null
try {
    [Environment]::CurrentDirectory=$root
    $arguments=@('-NoProfile','-File',(Join-Path $PSScriptRoot '../prepared-dimension/run.ps1'),'-Execute',
        '-RequestPath',$jobPath,'-ContextPath',$contextPath,'-PackageRoot',$source,'-OutputRoot',$root,
        '-SourceCommit',$SourceCommit,'-JournalBindingPath',$bindingPath,'-QualificationPauseAt',$Boundary)
    $capture={
        param($Worker)
        try {
            $timer=[Diagnostics.Stopwatch]::StartNew()
            while (-not [IO.File]::Exists($checkpointPath)) {
                if ($Worker.HasExited) { throw 'Worker exited before the native callback.' }
                if ($timer.ElapsedMilliseconds -ge 420000) { throw 'Native callback was not reached within seven minutes.' }
                Start-Sleep -Milliseconds 100
            }
            $captureClock=[Diagnostics.Stopwatch]::StartNew()
            $checkpoint=(Read-PreparedJson $checkpointPath).value
            $settings=(Read-PreparedJson (Join-Path $attempt 'settings.json')).value
            $progress=Read-PreparedJournalSupervisor (Join-Path $attempt 'progress.json')
            $owner=Get-RunnerProcessIdentity $Worker $executable
            Assert-PreparedNativeCallCheckpoint $checkpoint $job $binding $settings $progress $owner $SourceCommit $attempt
            if ($checkpoint.boundary -cne $Boundary) { throw 'Native callback is not the requested boundary.' }
            $state.workerIdentity=$owner; $captureState.checkpoint=$checkpoint
            Set-NativeCallDescendant $Worker $state $checkpoint helper
            Set-NativeCallDescendant $Worker $state $checkpoint native
            Assert-NativeCallActive $checkpoint $state $Worker $releasedPath $captureClock
            # Read-only ciphertext observation while the worker owns its lock.
            # After owner exit the normal store reader authenticates its binding.
            $captureState.cipherSha256=Get-PreparedHash $journalPath
            [void](Write-PreparedJson (Join-Path $root 'controller-before-stop.json') (@{boundary=$Boundary;sourceCommit=$SourceCommit;
                owner=$owner;helper=$state.helperIdentity;helperParentPid=$state.helperParentPid;
                native=$state.nativeIdentity;nativeParentPid=$state.nativeParentPid;checkpointSha256=(Get-PreparedHash $checkpointPath);
                journalCipherSha256=$captureState.cipherSha256;action='interrupt_exact_native_call_worker';
                observedAt=[DateTimeOffset]::UtcNow.ToString('o');captureElapsedMs=$captureClock.ElapsedMilliseconds}))
            Assert-NativeCallActive $checkpoint $state $Worker $releasedPath $captureClock
            Stop-NativeCallWorker $Worker $state
            if ($state.stopErrors.Count -ne 0 -or $state.workerExit -eq 0 -or -not $state.workerStopRequested -or
                -not $state.helperStopRequested -or $null -eq $state.helperExit -or $null -eq $state.nativeExit -or
                (Test-Path -LiteralPath $releasedPath)) { throw 'The active native callback interruption was not established.' }
            [void](Write-PreparedJson (Join-Path $root 'controller-after-stop.json') (@{owner=$owner;workerExit=$state.workerExit;
                workerStopRequested=$state.workerStopRequested;helper=$state.helperIdentity;helperExit=$state.helperExit;
                helperStopRequested=$state.helperStopRequested;native=$state.nativeIdentity;nativeExit=$state.nativeExit;
                nativeStopRequested=$state.nativeStopRequested;stopAdmission=$false;retryAuthorized=$false}))
        } catch { $captureState.controllerError=$_.Exception.Message }
    }
    $cleanup={param($Worker,$State) Stop-NativeCallWorker $Worker $State}
    $workerProcess=New-Object System.Diagnostics.Process
    $observation=Invoke-QualificationWorker $workerProcess $executable $arguments (Join-Path $root 'worker') $state $capture $cleanup
    if ($captureState.controllerError) { throw $captureState.controllerError }
    if ($observation.error -or $null -eq $captureState.checkpoint -or $null -eq $captureState.cipherSha256 -or
        $observation.exitCode -ne $state.workerExit) { throw 'Native call controller failed; retain all evidence.' }
    if ((Test-Path (Join-Path $attempt 'result.json')) -or (Test-Path (Join-Path $attempt 'supervisor-final.json'))) { throw 'Interrupted worker unexpectedly finalized a receipt.' }
    $reader=Open-NativeJournalStore $binding $false
    if ((Get-PreparedHash $reader.statePath) -cne $captureState.cipherSha256) { throw 'Acknowledged journal changed during interruption.' }
    $journal=Read-NativeJournalStore $reader
    Assert-NativeCallInterruptedJournal $journal $binding $captureState.checkpoint
    $summary=Get-NativeJournalSummary $journal
    [void](Write-PreparedBytes (Join-Path $root 'journal-after-crash.json') ([Text.Encoding]::UTF8.GetBytes((ConvertTo-JournalJson $journal))))
    $statePath=$reader.statePath; $reader.lock.Dispose(); $reader=$null
    $refused=$false
    try { $unexpected=New-RunnerJournal $binding; $unexpected.store.lock.Dispose() } catch { $refused=$true }
    if (-not $refused -or (Get-PreparedHash $statePath) -cne $captureState.cipherSha256) { throw 'Old attempt was relaunched or rewritten.' }
    Assert-CumulativeSameFiles (Measure-PreparedPackage $source -RequireOriginal) $files
    $after=@(Get-Process -ErrorAction Stop)
    try { if (@($after | Where-Object {$_.ProcessName -ieq 'SLDWORKS'}).Count -ne 0) { throw 'Native processes remain; no further case is admitted.' } }
    finally { foreach ($process in $after) { $process.Dispose() } }
} catch { $errorMessage=$_.Exception.Message }
finally {
    [Environment]::CurrentDirectory=$oldDirectory
    if ($null -ne $reader) { $reader.lock.Dispose() }
    foreach ($role in @('helper','native')) { if ($null -ne $state.$role) { $state.$role.Dispose() } }
}
if ($null -eq $errorMessage -and $state.stopErrors.Count -ne 0) { $errorMessage=[string]::Join(' ', $state.stopErrors.ToArray()) }
$outcome='failed'; if ($null -eq $errorMessage) { $outcome='passed' }
[void](Write-PreparedJson (Join-Path $root 'qualification.json') (@{schema='overdrafter.native-call-qualification.v1';
    outcome=$outcome;boundary=$Boundary;binding=$binding;sourceCommit=$SourceCommit;observation=$observation;
    journalSummary=$summary;error=$errorMessage;stopAdmission=$false;retryAuthorized=$false;
    cleanup=@{workerIdentity=$state.workerIdentity;workerExit=$state.workerExit;workerStopRequested=$state.workerStopRequested;
        helperIdentity=$state.helperIdentity;helperVerified=$state.helperVerified;helperParentPid=$state.helperParentPid;
        helperExit=$state.helperExit;helperStopRequested=$state.helperStopRequested;
        nativeIdentity=$state.nativeIdentity;nativeVerified=$state.nativeVerified;nativeParentPid=$state.nativeParentPid;
        nativeExit=$state.nativeExit;nativeStopRequested=$state.nativeStopRequested;errors=@($state.stopErrors.ToArray())};
    limitations=@('Synthetic synchronous open/save pre-notification interruption only; no partial disk-write corruption coverage.',
        'No unknown-child discovery, fresh-session artifact recovery, candidate finalization, retry or server admission.')}))
if ($errorMessage) { throw $errorMessage }
Write-Output (Join-Path $root 'qualification.json')
