#requires -Version 5.1
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot '../attempt-journal/JournalContract.ps1')

function Read-StopTime($Value) {
    Assert-CompanionTimestamp $Value
    if ($Value -cnotmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\z') { throw 'Observer time must be canonical UTC milliseconds.' }
    return [DateTimeOffset]::Parse($Value,[Globalization.CultureInfo]::InvariantCulture)
}
function Assert-StopRequest($Request) {
    Assert-CompanionKeys $Request @('binding','contextSha256','deadline','observerRunId')
    Assert-JournalBinding $Request.binding; Assert-JournalDigest $Request.contextSha256
    Assert-JournalId $Request.observerRunId; $null=Read-StopTime $Request.deadline
}
function Assert-StopProcess($Process,$Started,$Observed) {
    Assert-CompanionKeys $Process @('identity','executableSha256','parentPid','observedAt','exitCode','exitedAt')
    Assert-CompanionKeys $Process.identity @('pid','creationTicks','sessionId','executablePath')
    Assert-JournalProcessIdentity $Process.identity; Assert-JournalPath $Process.identity.executablePath
    Assert-JournalDigest $Process.executableSha256; Assert-JournalInteger $Process.parentPid 0 2147483647
    Assert-JournalInteger $Process.exitCode -2147483648 2147483647
    $created=Read-StopTime $Process.observedAt; $exited=Read-StopTime $Process.exitedAt
    if ($created -lt $Started -or $created -gt $exited -or $exited -gt $Observed -or
        [long]$Process.identity.creationTicks -lt $Started.UtcTicks -or
        [long]$Process.identity.creationTicks -gt $created.UtcTicks+9999) { throw 'Process observation lies outside this run.' }
}
# Pure consumer check. This function checks consistency, NOT producer authenticity.
# Only the independent observer calls it with observations from its retained handles.
function New-StopManifest($Request,[string]$JournalText,$Observation) {
    Assert-StopRequest $Request
    Assert-CompanionKeys $Observation @('startedAt','observedAt','root','processes','totalProcesses','activeProcesses','limitedProcesses')
    $started=Read-StopTime $Observation.startedAt; $observed=Read-StopTime $Observation.observedAt
    $deadline=Read-StopTime $Request.deadline
    if ($observed -lt $started -or $observed -ge $deadline -or ($deadline-$started).TotalMilliseconds -gt 600000) { throw 'Observer deadline expired or invalid.' }
    if ($Observation.processes -isnot [array] -or $Observation.processes.Count -lt 1 -or $Observation.processes.Count -gt 128) { throw 'Invalid observed process set.' }
    Assert-JournalInteger $Observation.totalProcesses 2 129
    Assert-JournalInteger $Observation.activeProcesses 0 0; Assert-JournalInteger $Observation.limitedProcesses 0 0
    if ($Observation.totalProcesses -ne $Observation.processes.Count+1) { throw 'Missed or unknown job process.' }
    Assert-StopProcess $Observation.root $started $observed
    $journal=Read-NativeJournalText $JournalText
    $summary=Get-NativeJournalSummary $journal
    if (-not $summary.recordedProcessesExited -or $summary.launches -ne $Observation.processes.Count -or
        (ConvertTo-JournalJson $journal.binding) -cne (ConvertTo-JournalJson $Request.binding)) { throw 'Journal binding, launch gap or terminal set differs.' }
    foreach ($record in $journal.records) {
        $at=Read-StopTime $record.at
        if ($at -lt $started -or $at -gt $observed) { throw 'Journal lies outside observation.' }
    }
    $byPid=@{}; $byPid[[int]$Observation.root.identity.pid]=$Observation.root
    foreach ($process in $Observation.processes) {
        Assert-StopProcess $process $started $observed
        if ($byPid.ContainsKey([int]$process.identity.pid) -or $process.parentPid -ne $Observation.root.identity.pid -or
            $process.identity.sessionId -ne $Observation.root.identity.sessionId -or
            [long]$process.identity.creationTicks -lt [long]$Observation.root.identity.creationTicks) { throw 'PID reuse or unknown descendant.' }
        $byPid[[int]$process.identity.pid]=$process
    }
    $used=@{}; $terminals=@()
    foreach ($record in @($journal.records | Where-Object { $_.kind -ceq 'process_started' })) {
        $data=$record.data
        if (-not $byPid.ContainsKey([int]$data.pid) -or $data.pid -eq $Observation.root.identity.pid -or $used.ContainsKey([int]$data.pid)) { throw 'Creation lacks unique independent identity.' }
        $actual=$byPid[[int]$data.pid]; $identity=$actual.identity; $used[[int]$data.pid]=$true
        if ($data.creationTicks -cne $identity.creationTicks -or $data.sessionId -ne $identity.sessionId -or
            -not [string]::Equals($data.executablePath,$identity.executablePath,[StringComparison]::OrdinalIgnoreCase) -or
            $data.executableSha256 -cne $actual.executableSha256) { throw 'Independent creation differs.' }
        $exit=@($journal.records | Where-Object { $_.kind -ceq 'process_exited' -and $_.data.launchId -ceq $data.launchId })
        if ($exit.Count -ne 1 -or $exit[0].data.exitCode -ne $actual.exitCode -or $exit[0].data.terminationRequested) { throw 'Independent terminal differs or termination provenance unavailable.' }
        $terminals+=@([pscustomobject]@{launchId=$data.launchId;pid=$identity.pid;creationTicks=$identity.creationTicks;
            sessionId=$identity.sessionId;executableSha256=$actual.executableSha256;exitCode=$actual.exitCode;terminationRequested=$false})
    }
    if ($used.Count -ne $Observation.processes.Count) { throw 'Unknown descendant outside journal.' }
    $success=$summary.phase -ceq 'outputs_saved' -and $null -eq $summary.failureCode -and $Observation.root.exitCode -eq 0 -and
        @($terminals | Where-Object { $_.exitCode -ne 0 }).Count -eq 0
    $outcome='native_failed'; $failure=$summary.failureCode
    if ($success) { $outcome='native_exit_succeeded' } elseif ($null -eq $failure) { $failure='unclassified' }
    # Frozen by canonical serialization; these are source evidence, never an admission.
    $manifest=[pscustomobject]@{schema='overdrafter.native-stop-observer.v1';observerVersion='windows-job-observer/1';
        observerRunId=$Request.observerRunId;binding=$Request.binding;contextSha256=$Request.contextSha256;deadline=$Request.deadline;
        startedAt=$Observation.startedAt;observedAt=$Observation.observedAt;journalSha256=(Get-JournalDigest $JournalText);
        journalHeadSha256=$journal.headSha256;boundary='trusted-user-direct-createprocess-job-v1';
        verdict='complete_in_job_envelope';root=$Observation.root;observedProcesses=@($Observation.processes | Sort-Object { $_.identity.pid });
        totalProcesses=$Observation.totalProcesses;activeProcesses=0;limitedProcesses=0;
        terminalProcesses=@($terminals | Sort-Object launchId);executionOutcome=$outcome;failureCode=$failure;
        stopAdmission=$false;nativeQualification=$false}
    return ConvertTo-JournalJson $manifest
}
