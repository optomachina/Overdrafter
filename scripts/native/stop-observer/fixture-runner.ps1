#requires -Version 5.1
# Inert Windows fixture only: fixed PowerShell sleeps, no CAD, network or secrets.
param([string]$RequestPath,[string]$CaseDirectory,[ValidateSet('valid','unknown','missed','gap','missing_terminal','long')][string]$Scenario='valid')
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot '../attempt-journal/JournalRunner.ps1')
. (Join-Path $PSScriptRoot '../file-admission/OwnedProcess.ps1')
$request=ConvertFrom-CompanionJson ([IO.File]::ReadAllText($RequestPath))
$session=New-RunnerJournal $request.binding
try {
    [IO.File]::WriteAllText((Join-Path $CaseDirectory 'root-started'),'fixture')
    $exe=Join-Path $PSHOME 'powershell.exe'
    if ($Scenario -eq 'long') { Start-Sleep -Seconds 30; exit 0 }
    if ($Scenario -eq 'gap') { $null=New-RunnerJournalLaunch $session compiler $exe @('-NoProfile') $CaseDirectory; exit 0 }
    if ($Scenario -in @('unknown','missed')) {
        $unknown=New-Object Diagnostics.Process
        $unknown.StartInfo.FileName=$exe; $unknown.StartInfo.Arguments='-NoProfile -NonInteractive -Command "Start-Sleep -Milliseconds 750"'
        if ($Scenario -eq 'missed') { $unknown.StartInfo.Arguments='-NoProfile -NonInteractive -Command exit' }
        $unknown.StartInfo.UseShellExecute=$false; $unknown.StartInfo.CreateNoWindow=$true
        if (-not $unknown.Start()) { throw 'Fixture launch failed.' }
        try { if (-not $unknown.WaitForExit(10000)) { throw 'Fixture wait failed.' } } finally { $unknown.Dispose() }
        [IO.File]::WriteAllText((Join-Path $CaseDirectory 'unknown-exited'),'fixture')
    }
    if ($Scenario -eq 'missing_terminal') {
        $launch=New-RunnerJournalLaunch $session compiler $exe @('-NoProfile') $CaseDirectory
        $process=New-Object Diagnostics.Process
        $process.StartInfo.FileName=$exe; $process.StartInfo.Arguments='-NoProfile -NonInteractive -Command "Start-Sleep -Seconds 5"'
        $process.StartInfo.UseShellExecute=$false; $process.StartInfo.CreateNoWindow=$true
        if (-not $process.Start()) { throw 'Fixture launch failed.' }
        try { Set-RunnerJournalCreation $session $launch $process; if (-not $process.WaitForExit(10000)) { throw 'Fixture wait failed.' } }
        finally { $process.Dispose() }
    } else {
        $result=Invoke-RunnerJournalChild $session compiler $exe @('-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 5') 15000 (Join-Path $CaseDirectory 'child')
        if ($null -ne $result.error -or $result.exitCode -ne 0) { throw 'Fixture child failed.' }
    }
    # Keep the live parent available until the independent observer has sampled
    # the child's identity; completed observation still comes from its handle.
    Start-Sleep -Seconds 1
} catch { [IO.File]::WriteAllText((Join-Path $CaseDirectory 'fixture-error.txt'),$_.ToString()); throw }
finally { $session.store.lock.Dispose() }
