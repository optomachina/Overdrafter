#requires -Version 5.1
<#
.SYNOPSIS
Qualifies retained PowerShell test children and journal writes, never CAD.
.DESCRIPTION
Explicit synthetic execution only. Retain every journal and log. Three fixed
PowerShell children exercise normal exit, late identity and an owned-child timeout; no native
package, pairing, credential or server admission is involved.
#>
[CmdletBinding()]
param([switch]$QualifyProcesses)
if (-not $QualifyProcesses) { throw 'Explicit -QualifyProcesses is required.' }
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'JournalRunner.ps1')
. (Join-Path $PSScriptRoot '../file-admission/OwnedProcess.ps1')
Assert-CompanionWindows
$binding=[pscustomobject]@{organizationId=[Guid]::NewGuid().ToString();projectId=[Guid]::NewGuid().ToString();workerId=[Guid]::NewGuid().ToString();
    installationId=[Guid]::NewGuid().ToString();bootId=[Guid]::NewGuid().ToString();taskId=[Guid]::NewGuid().ToString();attemptId=[Guid]::NewGuid().ToString();
    jobId=[Guid]::NewGuid().ToString();fence=1;jobSha256=('a'*64);runtimeAdmissionId=[Guid]::NewGuid().ToString()}
$session=$null; $fast=$null; $oldDirectory=[Environment]::CurrentDirectory; $script:checks=0
function Check-ProcessCase([bool]$Value,[string]$Label) { $script:checks++; if (-not $Value) { throw ('Process qualification failed: '+$Label) } }
try {
    $session=New-RunnerJournal $binding
    [Environment]::CurrentDirectory=$session.store.root
    $executable=Join-Path $PSHOME 'powershell.exe'
    $normal=Invoke-RunnerJournalChild $session compiler $executable @('-NoProfile','-NonInteractive','-Command','Start-Sleep -Milliseconds 3000; exit 0') 10000 (Join-Path $session.store.root 'normal')
    Check-ProcessCase ($null -eq $normal.error -and $normal.exitCode -eq 0 -and -not $normal.timedOut) 'normal retained child exit'
    Check-ProcessCase ($session.journal.records.Count -eq 3) 'normal intent creation exit'
    Check-ProcessCase ((Read-NativeJournalStore $session.store).headSha256 -ceq $session.journal.headSha256) 'normal acknowledged persistence'
    $arguments=@('-NoProfile','-NonInteractive','-Command','exit 0')
    $launch=New-RunnerJournalLaunch $session compiler $executable $arguments $session.store.root
    $fast=New-Object Diagnostics.Process
    $fast.StartInfo.FileName=$executable; $fast.StartInfo.Arguments='-NoProfile -NonInteractive -Command "exit 0"'
    $fast.StartInfo.UseShellExecute=$false; $fast.StartInfo.CreateNoWindow=$true
    $fast.StartInfo.WorkingDirectory=$session.store.root
    if (-not $fast.Start()) { throw 'Fast child start failed.' }
    if (-not $fast.WaitForExit(10000)) { throw 'Fast child exit remains unconfirmed; retain for recovery.' }
    Check-ProcessCase ($fast.HasExited -and $fast.ExitCode -eq 0) 'fast child exits before identity observation'
    Set-RunnerJournalCreation $session $launch $fast
    Set-RunnerJournalExit $session $launch $fast.ExitCode $false
    Check-ProcessCase ($launch.exited -and $session.journal.records.Count -eq 6) 'retained identity survives fast exit'
    $fast.Dispose(); $fast=$null
    $timeout=Invoke-RunnerJournalChild $session compiler $executable @('-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 20; exit 0') 2000 (Join-Path $session.store.root 'timeout')
    Check-ProcessCase ($null -eq $timeout.error -and $timeout.timedOut -and $timeout.terminationRequested -and $timeout.terminated -and $null -ne $timeout.exitCode) 'timeout observes owned child termination'
    Check-ProcessCase ($session.journal.records.Count -eq 9 -and $session.journal.records[-1].data.terminationRequested) 'timeout terminal evidence persisted'
    $summary=Get-NativeJournalSummary $session.journal
    Check-ProcessCase ($summary.recordedProcessesExited -and -not $summary.recoveryRequired -and -not $summary.stopAdmission -and -not $summary.retryAuthorized) 'recorded process set has no admission authority'
    Check-ProcessCase ((Read-NativeJournalStore $session.store).headSha256 -ceq $session.journal.headSha256) 'terminal checkpoint readback'
    $encoding=New-Object Text.UTF8Encoding($false,$true)
    [IO.File]::WriteAllText((Join-Path $session.store.root 'journal-observations.json'),(ConvertTo-JournalJson $session.journal),$encoding)
    [pscustomobject]@{schema='overdrafter.journal-process-qualification.v1';passed=$true;assertions=$checks;
        workerId=$binding.workerId;attemptId=$binding.attemptId;headSha256=$session.journal.headSha256;
        observedChildren=3;retained=$true;nativeActions=0} | ConvertTo-Json -Compress
} finally {
    [Environment]::CurrentDirectory=$oldDirectory
    if ($null -ne $fast) { $fast.Dispose() }
    if ($null -ne $session) { $session.store.lock.Dispose() }
}
