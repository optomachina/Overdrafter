#requires -Version 5.1
<#
.SYNOPSIS
Interrupts one exact prepared worker at an explicitly enabled test checkpoint.
.DESCRIPTION
One synthetic case, no retries. The controller retains its started worker and
captures a verified native descendant before interrupting the worker. It never
terminates by process name, rewrites the old journal or grants server authority.
All files and failure evidence remain available for reconciliation.
#>
[CmdletBinding()]
param(
    [switch]$QualifyWorkerCrash,
    [Parameter(Mandatory=$true)][ValidateSet('native_launch_intent','native_identity','outputs_saved','native_exit','startup_deadline')][string]$Boundary,
    [Parameter(Mandatory=$true)][string]$PackageRoot,
    [Parameter(Mandatory=$true)][string]$OutputRoot,
    [Parameter(Mandatory=$true)][string]$OrganizationId,
    [Parameter(Mandatory=$true)][string]$ProjectId,
    [Parameter(Mandatory=$true)][string]$SourceCommit
)
if (-not $QualifyWorkerCrash) { throw 'Explicit -QualifyWorkerCrash is required for one synthetic interruption.' }
$ErrorActionPreference='Stop'; Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot '../prepared-dimension/WireContract.ps1')
. (Join-Path $PSScriptRoot '../prepared-dimension/WireContractV2.ps1')
. (Join-Path $PSScriptRoot '../file-admission/OwnedProcess.ps1')
. (Join-Path $PSScriptRoot 'JournalRunner.ps1')
. (Join-Path $PSScriptRoot 'QualificationCheckpoint.ps1')
. (Join-Path $PSScriptRoot 'QualificationEvidence.ps1')
. (Join-Path $PSScriptRoot 'QualificationInputs.ps1')
. (Join-Path $PSScriptRoot 'CrashController.ps1')
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
$inputs=New-PreparedQualificationInputs $root $files $OrganizationId $ProjectId $SourceCommit
$job=$inputs.job; $binding=$inputs.binding; $jobPath=$inputs.jobPath
$contextPath=$inputs.contextPath; $bindingPath=$inputs.bindingPath
$attempt=Join-Path $root $job.attemptId; $checkpointPath=Join-Path $attempt 'qualification-checkpoint.json'
$executable=Join-Path $PSHOME 'powershell.exe'
$state=[pscustomobject]@{checkpoint=$null;native=$null;nativeIdentity=$null;workerExit=$null;nativeExit=$null;
    workerStopRequested=$false;nativeStopRequested=$false;nativeParentPid=$null;nativeVerified=$false;
    workerIdentity=$null;controllerError=$null;stopErrors=(New-Object 'System.Collections.Generic.List[string]')}
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
            if ($Worker.HasExited) { throw 'Worker exited before the requested checkpoint.' }
            if ($timer.ElapsedMilliseconds -ge 420000) { throw 'Qualification checkpoint was not reached within seven minutes.' }
            Start-Sleep -Milliseconds 100
        }
        $checkpoint=Read-PreparedJournalSupervisor $checkpointPath
        Assert-PreparedQualificationCheckpoint $checkpoint $Boundary $binding
        $owner=Get-RunnerProcessIdentity $Worker $executable
        if ((ConvertTo-JournalJson $owner) -cne (ConvertTo-JournalJson $checkpoint.owner)) { throw 'Checkpoint does not bind the directly started worker.' }
        $state.checkpoint=$checkpoint; $state.workerIdentity=$owner
        if ($Boundary -cin @('native_identity','outputs_saved','startup_deadline')) {
            $launch=@($checkpoint.journal.records | Where-Object {$_.kind -ceq 'launch_intent' -and $_.data.role -ceq 'native'})[0]
            $created=@($checkpoint.journal.records | Where-Object {$_.kind -ceq 'process_started' -and $_.data.launchId -ceq $launch.data.launchId})[0].data
            $candidate=[Diagnostics.Process]::GetProcessById($created.pid)
            try {
                $identity=Get-RunnerProcessIdentity $candidate $launch.data.executablePath
                if ($candidate.HasExited -or $identity.pid -ne $created.pid -or $identity.creationTicks -cne $created.creationTicks -or
                    $identity.sessionId -ne $created.sessionId -or
                    -not [string]::Equals($identity.executablePath,$created.executablePath,[StringComparison]::OrdinalIgnoreCase) -or
                    (Get-PreparedHash $identity.executablePath) -cne $created.executableSha256) { throw 'Native checkpoint identity differs from the retained process.' }
                $parent=@(Get-CimInstance Win32_Process -Filter ('ProcessId = '+$identity.pid) -ErrorAction Stop)
                if ($parent.Count -ne 1 -or $parent[0].ParentProcessId -ne $Worker.Id -or $Worker.HasExited) { throw 'Native process is not a child of the live qualified worker.' }
                $state.nativeParentPid=[int]$parent[0].ParentProcessId
                $state.native=$candidate; $state.nativeIdentity=$identity; $state.nativeVerified=$true; $candidate=$null
            } finally { if ($null -ne $candidate) { $candidate.Dispose() } }
        }
        [void](Write-PreparedJson (Join-Path $root 'controller-before-stop.json') (@{boundary=$Boundary;owner=$owner;
            native=$state.nativeIdentity;nativeParentPid=$state.nativeParentPid;checkpointSha256=(Get-PreparedHash $checkpointPath);
            sourceCommit=$SourceCommit;action='interrupt_exact_qualified_worker'}))
        if ($Worker.HasExited) { throw 'Worker exited before controlled interruption.' }
        Stop-QualificationWorker $Worker $state
        if ($state.stopErrors.Count -ne 0) { throw ([string]::Join(' ', $state.stopErrors.ToArray())) }
        if ($state.workerExit -eq 0) { throw 'Worker exited normally; crash was not established.' }
        [void](Write-PreparedJson (Join-Path $root 'controller-after-stop.json') (@{owner=$owner;workerExit=$state.workerExit;
            workerStopRequested=$state.workerStopRequested;native=$state.nativeIdentity;nativeExit=$state.nativeExit;
            nativeStopRequested=$state.nativeStopRequested;stopAdmission=$false;retryAuthorized=$false}))
        } catch {
            $state.controllerError=$_.Exception.Message
            Stop-QualificationWorker $Worker $state
        }
    }
    $workerProcess=New-Object System.Diagnostics.Process
    $observation=Invoke-QualificationWorker $workerProcess $executable $arguments (Join-Path $root 'worker') $state $capture
    if ($state.controllerError) { throw $state.controllerError }
    if ($observation.error -or $observation.timedOut -or -not $state.workerStopRequested -or
        $observation.exitCode -ne $state.workerExit -or $null -eq $state.checkpoint) { throw 'Controlled worker interruption was not established; retain all evidence.' }
    if ((Test-Path (Join-Path $attempt 'result.json')) -or (Test-Path (Join-Path $attempt 'supervisor-final.json'))) { throw 'Interrupted worker unexpectedly finalized a receipt.' }
    $reader=Open-NativeJournalStore $binding $false
    $cipherBefore=Get-PreparedHash $reader.statePath
    $journal=Read-NativeJournalStore $reader
    if ((ConvertTo-JournalJson $journal) -cne (ConvertTo-JournalJson $state.checkpoint.journal)) { throw 'Restart journal differs from its acknowledged checkpoint.' }
    [void](Write-PreparedBytes (Join-Path $root 'journal-after-crash.json') ([Text.Encoding]::UTF8.GetBytes((ConvertTo-JournalJson $journal))))
    $summary=Get-NativeJournalSummary $journal
    if ($Boundary -ceq 'startup_deadline') {
        $progress=Read-PreparedJournalSupervisor (Join-Path $attempt 'progress.json')
        Assert-PreparedDelayedReadiness $progress $job $binding.jobSha256 $SourceCommit
    }
    if ($summary.stopAdmission -or $summary.retryAuthorized) { throw 'Crash history acquired authority.' }
    if ($Boundary -ceq 'native_exit') {
        if (-not $summary.recordedProcessesExited -or $summary.recoveryRequired) { throw 'Exited native evidence changed after worker interruption.' }
    } elseif (-not $summary.recoveryRequired -or $summary.recordedProcessesExited) { throw 'An interrupted launch/exit gap was silently repaired.' }
    $statePath=$reader.statePath; $reader.lock.Dispose(); $reader=$null
    $refused=$false
    try { $unexpected=New-RunnerJournal $binding; $unexpected.store.lock.Dispose() } catch { $refused=$true }
    if (-not $refused -or (Get-PreparedHash $statePath) -cne $cipherBefore) { throw 'Old attempt was relaunched or rewritten.' }
    Assert-CumulativeSameFiles (Measure-PreparedPackage $source -RequireOriginal) $files
    $after=@(Get-Process -ErrorAction Stop)
    try { if (@($after | Where-Object {$_.ProcessName -ieq 'SLDWORKS'}).Count -ne 0) { throw 'Native processes remain; no further case is admitted.' } }
    finally { foreach ($process in $after) { $process.Dispose() } }
} catch { $errorMessage=$_.Exception.Message }
finally {
    [Environment]::CurrentDirectory=$oldDirectory
    if ($null -ne $reader) { $reader.lock.Dispose() }
    if ($null -ne $state.native) {
        # The helper may have confirmed owner exit after a callback failure.
        if ($null -ne $observation -and $null -ne $observation.exitCode) { $state.workerExit=$observation.exitCode; Stop-QualificationNative $state }
        $state.native.Dispose()
    }
}
if ($null -eq $errorMessage -and $state.stopErrors.Count -ne 0) { $errorMessage=[string]::Join(' ', $state.stopErrors.ToArray()) }
$outcome='failed'; if ($null -eq $errorMessage) { $outcome='passed' }
[void](Write-PreparedJson (Join-Path $root 'qualification.json') (@{schema='overdrafter.worker-crash-qualification.v1';
    outcome=$outcome;boundary=$Boundary;binding=$binding;sourceCommit=$SourceCommit;observation=$observation;
    journalSummary=$summary;error=$errorMessage;stopAdmission=$false;retryAuthorized=$false;
    cleanup=@{workerIdentity=$state.workerIdentity;workerExit=$state.workerExit;workerStopRequested=$state.workerStopRequested;
        nativeIdentity=$state.nativeIdentity;nativeVerified=$state.nativeVerified;nativeParentPid=$state.nativeParentPid;
        nativeExit=$state.nativeExit;nativeStopRequested=$state.nativeStopRequested;errors=@($state.stopErrors.ToArray())};
    limitations=@('Synthetic worker interruption; startup_deadline explicitly injects delayed readiness admission.',
        'No unknown-child, general startup-hang or interrupted-open/save qualification.','No candidate finalization, retry or server admission.')}))
if ($errorMessage) { throw $errorMessage }
Write-Output (Join-Path $root 'qualification.json')
