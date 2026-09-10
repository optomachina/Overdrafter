#requires -Version 5.1
. (Join-Path $PSScriptRoot 'JournalContract.ps1')

# Supervisor reports include native stdout and are larger than 64 KiB jobs.
# Read at most 2 MiB from one read-locked file before strict UTF-8 decoding;
# this qualification-only limit does not change request admission limits.
function Read-PreparedJournalSupervisor([string]$Path) {
    $stream=[IO.File]::Open($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    try {
        if ($stream.Length -lt 1 -or $stream.Length -gt 2097152) { throw 'Supervisor report must be between 1 byte and 2 MiB.' }
        $length=[int]$stream.Length
        $bytes=New-Object byte[] $length
        $offset=0
        while ($offset -lt $length) {
            $read=$stream.Read($bytes,$offset,$length-$offset)
            if ($read -eq 0) { throw 'Supervisor report changed during read.' }
            $offset+=$read
        }
        if ($stream.ReadByte() -ne -1) { throw 'Supervisor report changed during read.' }
    } finally { $stream.Dispose() }
    if ($length -ge 3 -and $bytes[0] -eq 239 -and $bytes[1] -eq 187 -and $bytes[2] -eq 191) { throw 'Supervisor report must omit the UTF-8 BOM.' }
    $encoding=New-Object Text.UTF8Encoding($false,$true)
    return ConvertFrom-CompanionJson ($encoding.GetString($bytes))
}

# Validate distinct readiness/close observations after role counts and replay pass.
function Assert-PreparedLifecycleCoverage($Journal,$Launches) {
    $native=@($launches | Where-Object { $_.data.role -ceq 'native' })[0]
    $created=@($journal.records | Where-Object { $_.kind -ceq 'process_started' -and $_.data.launchId -ceq $native.data.launchId })[0]
    $closed=@($journal.records | Where-Object { $_.kind -ceq 'process_exited' -and $_.data.launchId -ceq $native.data.launchId })[0]
    $startup=@($journal.records | Where-Object { $_.kind -ceq 'phase' -and $_.data.phase -ceq 'startup_wait' })[0].sequence
    $ready=@($journal.records | Where-Object { $_.kind -ceq 'phase' -and $_.data.phase -ceq 'startup_ready' })[0].sequence
    $saved=@($journal.records | Where-Object { $_.kind -ceq 'phase' -and $_.data.phase -ceq 'outputs_saved' })[0].sequence
    $arguments=@([string]$created.data.pid,$created.data.creationTicks,[string]$created.data.sessionId)
    $inspectHash=Get-JournalDigest (ConvertTo-JournalJson (@('inspect')+$arguments))
    $closeHash=Get-JournalDigest (ConvertTo-JournalJson (@('graceful-close-empty')+$arguments))
    $readinessCount=0; $closeCount=0
    foreach ($launch in @($launches | Where-Object { $_.data.role -ceq 'lifecycle' })) {
        if ($launch.sequence -gt $startup -and $launch.sequence -lt $ready -and $launch.data.argumentsSha256 -ceq $inspectHash) { $readinessCount++ }
        elseif ($launch.sequence -gt $saved -and $launch.sequence -lt $closed.sequence -and $launch.data.argumentsSha256 -ceq $closeHash) { $closeCount++ }
        else { throw 'Lifecycle mode or phase binding differs.' }
    }
    if ($readinessCount -lt 1 -or $closeCount -ne 1) { throw 'Native journal lacks distinct readiness and close observations.' }
}

# Prepared-run qualification only: this validates the supplied record set and
# supervisor, not authenticated origin or absence of unobserved child processes.
function Assert-PreparedJournalEvidence([string]$Text,$Supervisor,$Binding,[string]$ArtifactSha256) {
    Assert-JournalBinding $Binding
    Assert-JournalId $Supervisor.jobId; Assert-JournalId $Supervisor.attemptId
    Assert-JournalDigest $Supervisor.requestSha256
    if ($Supervisor.jobId -cne $Binding.jobId -or $Supervisor.attemptId -cne $Binding.attemptId -or
        $Supervisor.requestSha256 -cne $Binding.jobSha256) { throw 'Supervisor qualification binding differs.' }
    Assert-CompanionKeys $Supervisor.journal @('sha256','headSha256','records','recordedProcessesExited','recoveryRequired')
    Assert-JournalDigest $ArtifactSha256; Assert-JournalDigest $Supervisor.journal.sha256; Assert-JournalDigest $Supervisor.journal.headSha256
    if ($ArtifactSha256 -cne $Supervisor.journal.sha256 -or $ArtifactSha256 -cne (Get-JournalDigest $Text)) { throw 'Canonical journal artifact bytes differ.' }
    $journal=Read-NativeJournalText $Text $Supervisor.journal.headSha256
    if ((ConvertTo-JournalJson $journal.binding) -cne (ConvertTo-JournalJson $Binding)) { throw 'Journal qualification binding differs.' }
    $summary=Get-NativeJournalSummary $journal
    Assert-JournalInteger $Supervisor.journal.records 1 2048
    if ($Supervisor.journal.records -ne $summary.records -or $Supervisor.journal.recordedProcessesExited -isnot [bool] -or
        -not $Supervisor.journal.recordedProcessesExited -or $Supervisor.journal.recoveryRequired -isnot [bool] -or $Supervisor.journal.recoveryRequired -or
        -not $summary.recordedProcessesExited -or $summary.recoveryRequired -or $summary.stopAdmission -or $summary.retryAuthorized -or
        $summary.phase -cne 'outputs_saved' -or $null -ne $summary.failureCode) { throw 'Native journal is incomplete or failed.' }
    $launches=@($journal.records | Where-Object { $_.kind -ceq 'launch_intent' })
    foreach ($role in @(@('compiler',2),@('native',1),@('operation',1))) {
        if (@($launches | Where-Object { $_.data.role -ceq $role[0] }).Count -ne $role[1]) { throw 'Native journal launch coverage differs.' }
    }
    Assert-PreparedLifecycleCoverage $journal $launches
    return $summary
}
