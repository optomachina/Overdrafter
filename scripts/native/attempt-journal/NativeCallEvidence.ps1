#requires -Version 5.1
# Pure qualification binding checks. A valid callback receipt grants no process
# ownership: the controller must independently retain and verify each live handle.
. (Join-Path $PSScriptRoot 'QualificationCheckpoint.ps1')

# After the owner exits, its unchanged journal must still contain the exact two
# live callback processes. External cleanup must not fill either exit gap.
function Assert-NativeCallInterruptedJournal($Journal,$Binding,$Checkpoint) {
    $summary=Get-NativeJournalSummary $Journal
    if ((ConvertTo-JournalJson $Journal.binding) -cne (ConvertTo-JournalJson $Binding) -or
        $summary.phase -cne 'operation_started' -or $null -ne $summary.failureCode -or
        $summary.unresolvedLaunches -ne 2 -or -not $summary.recoveryRequired -or
        $summary.recordedProcessesExited -or $summary.stopAdmission -or $summary.retryAuthorized) { throw 'Native call history no longer represents the interrupted operation.' }
    foreach ($role in @('native','operation')) {
        $prefix='native'; if ($role -ceq 'operation') { $prefix='helper' }
        $launches=@($Journal.records | Where-Object {$_.kind -ceq 'launch_intent' -and $_.data.role -ceq $role})
        if ($launches.Count -ne 1) { throw 'Native call history has an unexpected launch set.' }
        $launch=$launches[0].data
        $created=@($Journal.records | Where-Object {$_.kind -ceq 'process_started' -and $_.data.launchId -ceq $launch.launchId})
        $exited=@($Journal.records | Where-Object {$_.kind -ceq 'process_exited' -and $_.data.launchId -ceq $launch.launchId})
        if ($created.Count -ne 1 -or $exited.Count -ne 0) { throw 'Native call creation/exit evidence differs.' }
        $identity=$created[0].data
        if ($identity.pid -ne $Checkpoint.($prefix+'Pid') -or $identity.creationTicks -cne $Checkpoint.($prefix+'CreationTicks') -or
            $identity.sessionId -ne $Checkpoint.sessionId -or $identity.executableSha256 -cne $Checkpoint.($prefix+'Sha256') -or
            $launch.executableSha256 -cne $Checkpoint.($prefix+'Sha256') -or
            -not [string]::Equals($identity.executablePath,$Checkpoint.($prefix+'Path'),[StringComparison]::OrdinalIgnoreCase) -or
            -not [string]::Equals($launch.executablePath,$Checkpoint.($prefix+'Path'),[StringComparison]::OrdinalIgnoreCase)) { throw 'Native call journal process does not match its receipt.' }
    }
}

function Assert-PreparedNativeCallCheckpoint($Checkpoint,$Job,$Binding,$Settings,$Progress,$Owner,[string]$SourceCommit,[string]$AttemptRoot) {
    Assert-PreparedQualificationScope $Job $Binding $SourceCommit
    Assert-JournalId $Settings.qualificationNonce
    Assert-CompanionKeys $Checkpoint @('schema','phase','boundary','sourceCommit','nonce','jobId','attemptId',
        'requestSha256','contextSha256','eventName','path','candidateRoot','pauseMs','helperPid','helperCreationTicks',
        'sessionId','helperPath','helperSha256','nativePid','nativeCreationTicks','nativePath','nativeSha256','utc')
    foreach ($field in @('schema','phase','boundary','sourceCommit','nonce','jobId','attemptId','requestSha256',
        'contextSha256','eventName','path','candidateRoot','helperCreationTicks','helperPath','helperSha256',
        'nativeCreationTicks','nativePath','nativeSha256','utc')) {
        if ($Checkpoint.$field -isnot [string]) { throw 'Native call text must be scalar.' }
    }
    foreach ($field in @('qualificationSourceCommit','qualificationBoundary','candidateRoot','jobId','attemptId','requestSha256','contextSha256')) {
        if ($Settings.$field -isnot [string]) { throw 'Native call settings text must be scalar.' }
    }
    Assert-JournalInteger $Settings.expectedDepthMm 5 5
    Assert-JournalInteger $Settings.depthMm 8 8
    Assert-JournalInteger $Checkpoint.pauseMs 60000 60000
    if ($Checkpoint.schema -cne 'overdrafter.native-call-checkpoint.v1' -or $Checkpoint.phase -cne 'entered' -or
        $Checkpoint.sourceCommit -cne $SourceCommit -or $Settings.qualificationSourceCommit -cne $SourceCommit -or
        $Checkpoint.boundary -cne $Settings.qualificationBoundary -or $Checkpoint.nonce -cne $Settings.qualificationNonce) { throw 'Native call checkpoint mode differs.' }
    foreach ($value in @($Checkpoint,$Settings,$Progress)) {
        if ($value.jobId -cne $Job.jobId -or $value.attemptId -cne $Job.attemptId -or
            $value.requestSha256 -cne $Binding.jobSha256) { throw 'Native call attempt identity differs.' }
    }
    if ($Checkpoint.contextSha256 -cne $Job.contextSha256 -or $Settings.contextSha256 -cne $Job.contextSha256 -or
        $Progress.sourceCommit -cne $SourceCommit -or $Progress.stage -cne 'native_dimension' -or
        $Settings.expectedDepthMm -ne 5 -or $Settings.depthMm -ne 8) { throw 'Native call operation differs.' }
    Assert-CumulativeSameFiles $Settings.inputFiles $PreparedFiles
    $eventName=$null; $relative='parts/baseline-5mm.SLDPRT'
    switch -CaseSensitive ($Checkpoint.boundary) {
        'open_call' { $eventName='FileOpenPreNotify' }
        'part_save_call' { $eventName='Part.FileSaveNotify' }
        'assembly_save_call' { $eventName='Assembly.FileSaveNotify'; $relative='synthetic-assembly.SLDASM' }
        default { throw 'Unsupported native call boundary.' }
    }
    Assert-JournalPath $AttemptRoot
    $candidate=$AttemptRoot.TrimEnd('\')+'\candidate'
    $helper=$AttemptRoot.TrimEnd('\')+'\PreparedDimensionProbe.exe'
    $path=$candidate+'\'+$relative.Replace('/','\')
    foreach ($pair in @(@($Checkpoint.candidateRoot,$candidate),@($Settings.candidateRoot,$candidate),
        @($Checkpoint.helperPath,$helper),@($Checkpoint.path,$path),
        @($Checkpoint.nativePath,'C:\Program Files\SOLIDWORKS 2022\SOLIDWORKS\SLDWORKS.exe'))) {
        Assert-JournalPath $pair[0]
        if (-not [string]::Equals($pair[0],$pair[1],[StringComparison]::OrdinalIgnoreCase)) { throw 'Native call path differs.' }
    }
    if ($Checkpoint.eventName -cne $eventName -or $Checkpoint.helperSha256 -cne $Progress.binaries.PreparedDimensionProbe -or
        $Checkpoint.nativeSha256 -cne '6384c0829bac149831be5fdc9e705c90612273d25b46fdff5e5760d11e22d6cc') { throw 'Native call event or binary differs.' }
    Assert-JournalDigest $Checkpoint.helperSha256
    Assert-JournalDigest $Progress.binaries.PreparedDimensionProbe
    Assert-JournalProcessIdentity ([pscustomobject]@{pid=$Progress.native.pid;creationTicks=$Progress.native.ticks;sessionId=$Progress.native.session})
    Assert-JournalProcessIdentity $Owner
    foreach ($identity in @(
        [pscustomobject]@{pid=$Checkpoint.helperPid;creationTicks=$Checkpoint.helperCreationTicks;sessionId=$Checkpoint.sessionId},
        [pscustomobject]@{pid=$Checkpoint.nativePid;creationTicks=$Checkpoint.nativeCreationTicks;sessionId=$Checkpoint.sessionId})) {
        Assert-JournalProcessIdentity $identity
        if ($identity.pid -eq $Owner.pid -or $identity.sessionId -ne $Owner.sessionId -or
            [long]$identity.creationTicks -lt [long]$Owner.creationTicks) { throw 'Native call process is outside its owner.' }
    }
    if ($Checkpoint.helperPid -eq $Checkpoint.nativePid -or
        [long]$Checkpoint.helperCreationTicks -lt [long]$Checkpoint.nativeCreationTicks -or
        $Checkpoint.nativePid -ne $Progress.native.pid -or $Checkpoint.nativeCreationTicks -cne $Progress.native.ticks -or
        $Checkpoint.sessionId -ne $Progress.native.session) { throw 'Native call process identity differs.' }
    if ($Checkpoint.utc -isnot [string] -or $Checkpoint.utc -cnotmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z\z') { throw 'Native call observation time differs.' }
    $at=[DateTimeOffset]::ParseExact($Checkpoint.utc,"yyyy-MM-dd'T'HH:mm:ss.fffffff'Z'",[Globalization.CultureInfo]::InvariantCulture,
        [Globalization.DateTimeStyles]::AssumeUniversal)
    if ($at.UtcTicks -lt [long]$Checkpoint.helperCreationTicks) { throw 'Native call predates its helper.' }
}
