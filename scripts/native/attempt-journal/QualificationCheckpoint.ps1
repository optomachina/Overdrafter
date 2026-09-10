#requires -Version 5.1
# Test-only coordination, never a server admission or a resumable worker state.
. (Join-Path $PSScriptRoot 'JournalContract.ps1')

function Assert-PreparedQualificationScope($Job,$Binding,[string]$SourceCommit) {
    Assert-JournalBinding $Binding
    Assert-CumulativeJob $Job
    if ($SourceCommit -cnotmatch '^[0-9a-f]{40}\z' -or $Job.sequence -ne 1 -or
        $Job.expectedDepthMm -ne 5 -or $Job.depthMm -ne 8 -or
        $Job.jobId -cne $Binding.jobId -or $Job.attemptId -cne $Binding.attemptId -or
        $Job.fence -ne $Binding.fence -or $Job.scope.organizationId -cne $Binding.organizationId -or
        $Job.scope.projectId -cne $Binding.projectId) { throw 'Qualification requires the exact original synthetic 5-to-8 job and journal.' }
    Assert-CumulativeSameFiles $Job.inputFiles $PreparedFiles
}

# Preserve the complete acknowledged journal plus owner identity at the barrier.
# The controller compares this owner with the Process it directly started.
function New-PreparedQualificationCheckpoint([string]$Boundary,$Binding,$Journal,$Owner) {
    if ($Boundary -cnotin @('native_launch_intent','native_identity','outputs_saved','native_exit','startup_deadline')) { throw 'Unsupported qualification boundary.' }
    Assert-JournalBinding $Binding
    if ((ConvertTo-JournalJson $Binding) -cne (ConvertTo-JournalJson $Journal.binding)) { throw 'Qualification attempt binding differs.' }
    Assert-CompanionKeys $Owner @('pid','creationTicks','sessionId','executablePath')
    Assert-JournalProcessIdentity $Owner; Assert-JournalPath $Owner.executablePath
    $summary=Get-NativeJournalSummary $Journal
    if (($summary.failureCode -and $Boundary -cne 'startup_deadline') -or $Journal.records.Count -eq 0) { throw 'Qualification requires its exact acknowledged boundary.' }
    $native=@($Journal.records | Where-Object {$_.kind -ceq 'launch_intent' -and $_.data.role -ceq 'native'})
    if ($native.Count -ne 1) { throw 'Qualification requires one native launch intent.' }
    $created=@($Journal.records | Where-Object {$_.kind -ceq 'process_started' -and $_.data.launchId -ceq $native[0].data.launchId})
    $last=$Journal.records[-1]
    if ($Boundary -ceq 'native_launch_intent') {
        if ($last.kind -cne 'launch_intent' -or $last.data.launchId -cne $native[0].data.launchId -or
            $created.Count -ne 0 -or $summary.phase -cne 'preflight' -or $summary.unresolvedLaunches -ne 1) { throw 'Native launch-intent boundary differs.' }
    } else {
        if ($created.Count -ne 1 -or $created[0].data.pid -eq $Owner.pid -or
            $created[0].data.sessionId -ne $Owner.sessionId -or [long]$created[0].data.creationTicks -lt [long]$Owner.creationTicks) { throw 'Native creation is outside the qualified owner.' }
        if ($Boundary -ceq 'startup_deadline') {
            if ($last.kind -cne 'failure' -or $last.data.code -cne 'native_startup_timeout' -or
                $summary.failureCode -cne 'native_startup_timeout' -or $summary.phase -cne 'startup_wait' -or
                $summary.unresolvedLaunches -ne 1 -or
                @($Journal.records | Where-Object {$_.kind -ceq 'launch_intent' -and $_.data.role -ceq 'operation'}).Count -ne 0) { throw 'Startup deadline boundary differs.' }
        } elseif ($Boundary -ceq 'native_exit') {
            if ($last.kind -cne 'process_exited' -or $last.data.launchId -cne $native[0].data.launchId -or
                $last.data.exitCode -ne 0 -or $last.data.terminationRequested -or -not $summary.recordedProcessesExited -or
                $summary.phase -cne 'outputs_saved') { throw 'Native exit boundary differs.' }
        } else {
            $phase='outputs_saved'; if ($Boundary -ceq 'native_identity') { $phase='startup_wait' }
            if ($last.kind -cne 'phase' -or $last.data.phase -cne $phase -or
                $summary.unresolvedLaunches -ne 1) { throw 'Live native qualification phase differs.' }
        }
    }
    return [pscustomobject]@{schema='overdrafter.worker-crash-checkpoint.v1';boundary=$Boundary;
        binding=$Binding;owner=$Owner;journal=$Journal}
}

function Assert-PreparedQualificationCheckpoint($Checkpoint,[string]$Boundary,$Binding) {
    Assert-CompanionKeys $Checkpoint @('schema','boundary','binding','owner','journal')
    $expected=New-PreparedQualificationCheckpoint $Boundary $Binding $Checkpoint.journal $Checkpoint.owner
    if ((ConvertTo-JournalJson $Checkpoint) -cne (ConvertTo-JournalJson $expected)) { throw 'Qualification checkpoint differs.' }
}

# Qualification evidence must distinguish a timely native response from the
# deliberate delay in admitting it. This check cannot grant retry authority.
function Assert-PreparedDelayedReadiness($Progress,$Job,[string]$JobHash,[string]$SourceCommit) {
    $startup=$Progress.startup
    if ($Progress.jobId -cne $Job.jobId -or $Progress.attemptId -cne $Job.attemptId -or
        $Progress.requestSha256 -cne $JobHash -or $Progress.sourceCommit -cne $SourceCommit -or
        $Progress.failureCode -cne 'native_startup_timeout' -or
        $startup.schema -cne 'overdrafter.native-startup-observation.v1' -or
        $startup.qualificationDelayedReadiness -cne $true -or $startup.guiReady -cne $true -or
        $startup.guiTimeoutMs -ne 60000 -or $startup.apiTimeoutMs -ne 60000 -or
        $startup.failureCode -cne 'native_startup_timeout' -or $startup.outcome -cne 'failed' -or
        $startup.probes -isnot [array] -or $startup.probes.Count -lt 1 -or $startup.probes.Count -gt 60) {
        throw 'Delayed-readiness source, scope or outcome differs.'
    }
    foreach ($value in @($startup.guiElapsedMs,$startup.apiElapsedMs)) {
        if (($value -isnot [int] -and $value -isnot [long]) -or $value -lt 0 -or $value -gt 600000) { throw 'Invalid startup elapsed time.' }
    }
    $delayed=@($startup.probes | Where-Object {$_.injectedDelayMs -eq 60000 -and $_.outcome -ceq 'ready'})
    if ($startup.guiElapsedMs -ge 60000 -or $startup.apiElapsedMs -lt 60000 -or $delayed.Count -ne 1) { throw 'Delayed-readiness deadline was not established.' }
    $probe=$delayed[0]
    foreach ($value in @($probe.startedMs,$probe.returnedMs,$probe.finishedMs,$probe.timeoutMs)) {
        if (($value -isnot [int] -and $value -isnot [long]) -or $value -lt 0 -or $value -gt 600000) { throw 'Invalid probe elapsed time.' }
    }
    if ($probe.startedMs -gt $probe.returnedMs -or $probe.returnedMs -ge 60000 -or
        $probe.finishedMs-$probe.returnedMs -lt 60000 -or $startup.apiElapsedMs -lt $probe.finishedMs -or
        $probe.timeoutMs -lt 1 -or $probe.timeoutMs -gt 30000 -or
        $probe.timeoutMs -gt 60000-$probe.startedMs) { throw 'Readiness return, injected delay or observation budget differs.' }
}

# There is deliberately no resume signal. The explicitly enabled test controller
# interrupts this owner; otherwise the bounded pause fails the attempt. Write to
# a fresh temporary file and atomically rename only after flush, so the controller
# never observes a partially published checkpoint.
function Wait-PreparedQualificationCheckpoint([string]$Selected,[string]$Boundary,[string]$Directory,$Session) {
    if ($Selected -cne $Boundary) { return }
    Assert-NativeJournalStore $Session.store
    $owner=[Diagnostics.Process]::GetCurrentProcess()
    try { $identity=Get-RunnerProcessIdentity $owner (Join-Path $PSHOME 'powershell.exe') }
    finally { $owner.Dispose() }
    $checkpoint=New-PreparedQualificationCheckpoint $Boundary $Session.journal.binding $Session.journal $identity
    $temporary=Join-Path $Directory 'qualification-checkpoint.pending'
    $final=Join-Path $Directory 'qualification-checkpoint.json'
    [void](Write-PreparedBytes $temporary ([Text.Encoding]::UTF8.GetBytes((ConvertTo-JournalJson $checkpoint))))
    [IO.File]::Move($temporary,$final)
    $timer=[Diagnostics.Stopwatch]::StartNew()
    while ($timer.ElapsedMilliseconds -lt 45000) { Start-Sleep -Milliseconds 100 }
    Throw-PreparedFailure 'deadline_exceeded' 'Qualification controller did not interrupt the bounded checkpoint.'
}
