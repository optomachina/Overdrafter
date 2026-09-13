#requires -Version 5.1
<#
.SYNOPSIS
Qualifies durable denial after observing a process absent from an attempt journal.
.DESCRIPTION
Explicit inert Windows fixture only. The harness starts and retains both test
children. One is deliberately absent from the journal, then reported as unknown.
This tests denial after observation, not descendant discovery or containment.
No CAD, server admission, retry, existing-process adoption or evidence deletion.
#>
[CmdletBinding()]
param([switch]$QualifyUnknownChild,[Parameter(Mandatory=$true)][string]$OutputRoot)
if (-not $QualifyUnknownChild) { throw 'Explicit -QualifyUnknownChild is required.' }
$ErrorActionPreference='Stop'; Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot '../prepared-dimension/WireContract.ps1')
. (Join-Path $PSScriptRoot '../file-admission/OwnedProcess.ps1')
. (Join-Path $PSScriptRoot 'JournalRunner.ps1')
Assert-CompanionWindows
if ($PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1) { throw 'Requires Desktop 5.1.' }
$root=Assert-CompanionLocalPath $OutputRoot
if ($root.Length -gt 45 -or (Test-Path -LiteralPath $root)) { throw 'Use a fresh fixture root of at most 45 characters.' }
$binding=[pscustomobject]@{organizationId=[Guid]::NewGuid().ToString();projectId=[Guid]::NewGuid().ToString();workerId=[Guid]::NewGuid().ToString();
    installationId=[Guid]::NewGuid().ToString();bootId=[Guid]::NewGuid().ToString();taskId=[Guid]::NewGuid().ToString();attemptId=[Guid]::NewGuid().ToString();
    jobId=[Guid]::NewGuid().ToString();fence=1;jobSha256=('a'*64);runtimeAdmissionId=[Guid]::NewGuid().ToString()}
New-Item -ItemType Directory -Path $root -ErrorAction Stop | Out-Null
$state=[pscustomobject]@{session=$null;checks=0;identity=$null;parentPid=$null;head=$null;cipher=$null;error=$null}
$oldDirectory=[Environment]::CurrentDirectory; $observation=$null; $summary=$null
function Check-UnknownChild([bool]$Value,[string]$Label) {
    $state.checks++; if (-not $Value) { throw ('Unknown-child qualification failed: '+$Label) }
}
try {
    [Environment]::CurrentDirectory=$root
    $state.session=New-RunnerJournal $binding
    [void](Write-PreparedJson (Join-Path $root 'binding.json') $binding)
    $executable=Join-Path $PSHOME 'powershell.exe'
    $arguments=@('-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 3; exit 0')
    $known=Invoke-RunnerJournalChild $state.session compiler $executable $arguments 30000 (Join-Path $root 'known')
    Check-UnknownChild ($null -eq $known.error -and $known.exitCode -eq 0 -and -not $known.timedOut) 'known child exited normally'
    $before=Get-NativeJournalSummary $state.session.journal
    Check-UnknownChild ($before.recordedProcessesExited -and -not $before.stopAdmission -and -not $before.retryAuthorized) 'known exits grant no authority'
    [void](Write-PreparedJson (Join-Path $root 'before.json') $state.session.journal)
    # This launch belongs to the fixture, deliberately outside the attempt's
    # launch records. It is never adopted from a PID or terminated by name.
    $arguments=@('-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 10; exit 0')
    [void](Write-PreparedJson (Join-Path $root 'fixture-launch.json') (@{executable=$executable;arguments=$arguments;
        executableSha256=(Get-PreparedHash $executable);role='fixture_only_unjournaled_child'}))
    $capture={
        param($Process)
        $state.identity=Get-RunnerProcessIdentity $Process $executable
        $owner=[Diagnostics.Process]::GetCurrentProcess()
        try {
            $ownerIdentity=Get-RunnerProcessIdentity $owner $executable
            $parents=@(Get-CimInstance Win32_Process -Filter ('ProcessId = '+$state.identity.pid) -ErrorAction Stop)
            Check-UnknownChild ($parents.Count -eq 1 -and $parents[0].ParentProcessId -eq $ownerIdentity.pid -and
                -not $Process.HasExited -and $state.identity.sessionId -eq $ownerIdentity.sessionId -and
                [long]$state.identity.creationTicks -ge [long]$ownerIdentity.creationTicks) 'live fixture child belongs to retained owner'
            $state.parentPid=[int]$parents[0].ParentProcessId
        } finally { $owner.Dispose() }
        Check-UnknownChild (@($state.session.journal.records | Where-Object {
            $_.kind -ceq 'process_started' -and $_.data.pid -eq $state.identity.pid -and
            $_.data.creationTicks -ceq $state.identity.creationTicks
        }).Count -eq 0) 'observed child has no attempt creation record'
        [void](Write-PreparedJson (Join-Path $root 'unknown-observation.json') (@{identity=$state.identity;
            parentPid=$state.parentPid;owner=$ownerIdentity;executableSha256=(Get-PreparedHash $executable);
            observedAt=[DateTimeOffset]::UtcNow.ToString('o');fixtureOwned=$true}))
        Add-RunnerJournalEvent $state.session uncertain ([pscustomobject]@{reason='unknown_child'})
        $state.head=$state.session.journal.headSha256
        $state.cipher=Get-PreparedHash $state.session.store.statePath
        $refused=$false
        try { $null=Invoke-RunnerJournalChild $state.session compiler $executable @() 1000 (Join-Path $root 'forbidden') }
        catch { $refused=$true }
        Check-UnknownChild ($refused -and (Get-PreparedHash $state.session.store.statePath) -ceq $state.cipher) 'new launch refused without rewriting acknowledged history'
        $state.session.store.lock.Dispose()
        $state.session= [pscustomobject]@{store=(Open-NativeJournalStore $binding $false);journal=$null}
        $state.session.journal=Read-NativeJournalStore $state.session.store
        Check-UnknownChild ($state.session.journal.headSha256 -ceq $state.head -and
            (Get-PreparedHash $state.session.store.statePath) -ceq $state.cipher -and
            $state.session.journal.binding.bootId -ceq $binding.bootId) 'reopen retains exact acknowledged history and original boot'
        return @{stdout=$Process.StandardOutput.ReadToEndAsync();stderr=$Process.StandardError.ReadToEndAsync()}
    }
    $observation=Invoke-OwnedProcess $executable $arguments 30000 (Join-Path $root 'unknown-fixture') -CaptureFactory $capture
    Check-UnknownChild ($null -eq $observation.error -and $observation.exitCode -eq 0 -and
        $observation.pid -eq $state.identity.pid -and
        -not $observation.timedOut -and -not $observation.terminationRequested) 'retained fixture child exited normally'
    $summary=Get-NativeJournalSummary $state.session.journal
    Check-UnknownChild ($summary.records -eq 4 -and $summary.unresolvedLaunches -eq 0 -and
        $summary.recoveryRequired -and -not $summary.recordedProcessesExited -and
        -not $summary.stopAdmission -and -not $summary.retryAuthorized) 'external fixture exit cannot clear unknown-child uncertainty'
    Check-UnknownChild ((Get-PreparedHash $state.session.store.statePath) -ceq $state.cipher) 'external exit leaves journal unchanged'
    [void](Write-PreparedJson (Join-Path $root 'after.json') $state.session.journal)
    $statePath=$state.session.store.statePath
    $state.session.store.lock.Dispose(); $state.session=$null
    $refused=$false
    try { $unexpected=New-RunnerJournal $binding; $unexpected.store.lock.Dispose() } catch { $refused=$true }
    Check-UnknownChild ($refused -and (Get-PreparedHash $statePath) -ceq $state.cipher) 'old attempt cannot restart or rewrite history'
} catch { $state.error=$_.Exception.Message }
finally {
    [Environment]::CurrentDirectory=$oldDirectory
    if ($null -ne $state.session) { $state.session.store.lock.Dispose() }
}
$outcome='failed'; if ($null -eq $state.error) { $outcome='passed' }
[void](Write-PreparedJson (Join-Path $root 'qualification.json') (@{schema='overdrafter.unknown-child-qualification.v1';
    outcome=$outcome;binding=$binding;assertions=$state.checks;observation=$observation;journalSummary=$summary;
    headSha256=$state.head;cipherSha256=$state.cipher;error=$state.error;nativeActions=0;
    limitation='Observed extra-process denial only; no general discovery, containment, stop admission or retry authority.'}))
if ($state.error) { throw $state.error }
Write-Output (Join-Path $root 'qualification.json')
