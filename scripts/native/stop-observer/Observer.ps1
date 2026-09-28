#requires -Version 5.1
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'Manifest.ps1')
. (Join-Path $PSScriptRoot '../attempt-journal/JournalRunner.ps1')

function Get-StopNow { return [DateTimeOffset]::UtcNow }
function Format-StopTime($Time) { return $Time.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'") }
function Assert-StopBudget($State) {
    if ($State.failed -or $State.clock.ElapsedMilliseconds -ge $State.budget -or (Get-StopNow) -ge $State.deadline) {
        $State.failed=$true; throw 'Independent observer lost or deadline expired.'
    }
}
function Open-StopBoundary($Executable,$Arguments,$Directory,[IntPtr[]]$AuthorityPipes) {
    if ($null -eq ('OverDrafter.StopObserver.JobBoundary' -as [type])) { Add-Type -Path @((Join-Path $PSScriptRoot 'DetachedProcess.cs'),(Join-Path $PSScriptRoot 'JobBoundary.cs')) }
    # Match JournalRunner's deliberately restricted argument convention.
    $parts=@($Executable)+@($Arguments)
    foreach ($part in $parts) { if ($part -isnot [string] -or $part -match '["\r\n]' -or $part.EndsWith('\')) { throw 'Unsupported observer launch argument.' } }
    $command=(@($parts | ForEach-Object { '"'+$_+'"' }) -join ' ')
    return New-Object OverDrafter.StopObserver.JobBoundary($Executable,$command,$Directory,$AuthorityPipes)
}
function Get-StopParent([int]$ProcessId) {
    $rows=@(Get-CimInstance Win32_Process -Filter ('ProcessId = '+$ProcessId) -ErrorAction Stop)
    if ($rows.Count -ne 1) { throw 'Independent parent observation missing.' }
    return [int]$rows[0].ParentProcessId
}
function Read-StopProcess($State,$Handle,[bool]$Root) {
    $path=[OverDrafter.StopObserver.JobBoundary]::Image($Handle)
    $identity=Get-RunnerProcessIdentity ([pscustomobject]@{Handle=$Handle}) $path
    $parent=0
    if (-not $Root) {
        if ($State.rootClosed -or [OverDrafter.StopObserver.JobBoundary]::Exited($State.job.RootHandle)) { throw 'Owner exited before child identity capture.' }
        $parent=Get-StopParent $identity.pid
        $State.job.RequireMember($Handle)
        if ($parent -ne $State.job.RootPid -or [OverDrafter.StopObserver.JobBoundary]::Exited($State.job.RootHandle)) { throw ('Unknown descendant or owner loss: pid='+$identity.pid+' parent='+$parent+' root='+$State.job.RootPid+' image='+$path+' rootExited='+[OverDrafter.StopObserver.JobBoundary]::Exited($State.job.RootHandle)) }
    }
    $hash=(Get-FileHash -LiteralPath $path -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
    Assert-StopBudget $State
    return [pscustomobject]@{handle=$Handle;closed=$false;value=[pscustomobject]@{identity=$identity;executableSha256=$hash;
        parentPid=$parent;observedAt=(Format-StopTime (Get-StopNow));exitCode=$null;exitedAt=$null}}
}
function Get-StopPids($State) { return $State.job.ReadPids() }
function Receive-StopExits($State) {
    foreach ($entry in $State.entries.Values) {
        if ($entry.closed -or -not [OverDrafter.StopObserver.JobBoundary]::Exited($entry.handle)) { continue }
        $identity=Get-RunnerProcessIdentity ([pscustomobject]@{Handle=$entry.handle}) $entry.value.identity.executablePath
        if ((ConvertTo-JournalJson $identity) -cne (ConvertTo-JournalJson $entry.value.identity)) { throw 'Retained identity changed.' }
        $entry.value.exitCode=[OverDrafter.StopObserver.JobBoundary]::ExitCode($entry.handle)
        $entry.value.exitedAt=Format-StopTime (Get-StopNow)
        Assert-StopBudget $State
        # Capture exact terminal proof before releasing kernel references. Job
        # accounting can then converge to zero without reopening any PID.
        $State.job.Release($entry.handle); $entry.closed=$true
        if ($identity.pid -eq $State.job.RootPid) { $State.rootClosed=$true }
    }
}
function Read-StopJournal($Binding) {
    $store=Open-NativeJournalStore $Binding $false
    try { return ConvertTo-JournalJson (Read-NativeJournalStore $store) }
    finally { $store.lock.Dispose() }
}
# Capture one previously unseen job member while its exact root is alive.
function Add-StopSample($State,[int]$ProcessId) {
    if ($state.entries.ContainsKey($processId)) {
        if ($state.entries[$processId].closed) { throw 'PID reuse after terminal observation.' }
        return
    }
    if ($state.entries.Count -ge 129) { throw 'Observer process bound exceeded.' }
    $handle=$state.job.OpenMember($processId)
    try {
        $entry=Read-StopProcess $state $handle $false
        if ($entry.value.identity.pid -ne $processId) { throw 'Sampled process identity differs.' }
        $state.entries[$processId]=$entry; $handle=[IntPtr]::Zero
    } finally { if ($handle -ne [IntPtr]::Zero) { $state.job.Release($handle) } }
}
# Observe the complete job until root and every retained child have terminal proof.
function Wait-StopBoundary($State) {
    while ($true) {
        Assert-StopBudget $state
        foreach ($processId in (Get-StopPids $state)) { Add-StopSample $state $processId }
        Receive-StopExits $state
        $counts=$state.job.ReadCounts(); Assert-StopBudget $state
        if ($counts.Limited -ne 0 -or $counts.Total -gt 129) { throw 'Job bound or limit violation.' }
        if ($state.rootClosed -and $counts.Active -eq 0) { break }
        Start-Sleep -Milliseconds 10
    }
    if ($counts.Total -ne $state.entries.Count -or @($state.entries.Values | Where-Object { -not $_.closed }).Count -ne 0) { throw 'Missed process or terminal observation.' }
    return $counts
}
# Publish only a complete canonical snapshot into the already claimed directory.
function Publish-StopManifest($State,$Output,$Sid,[string]$Journal,[string]$Manifest) {
    foreach ($item in @(@('journal.json',$Journal),@('manifest.pending',$Manifest))) {
        $stream=New-CompanionPrivateFile (Join-Path $Output $item[0]) $Sid
        try { $bytes=[Text.Encoding]::ASCII.GetBytes($item[1]); $stream.Write($bytes,0,$bytes.Length); $stream.Flush($true) }
        finally { $stream.Dispose() }
    }
    Assert-StopBudget $State
    [IO.File]::Move((Join-Path $Output 'manifest.pending'),(Join-Path $Output 'manifest.json'))
    return [pscustomobject]@{manifestPath=(Join-Path $Output 'manifest.json');sha256=(Get-JournalDigest $Manifest);stopAdmission=$false}
}
# Release only this observer's retained resources. Job disposal kills remaining
# in-job fixture processes; it does not synthesize terminal proof.
function Close-StopBoundary($State) {
    if ($null -eq $State.job) { return }
    try {
        foreach ($entry in $State.entries.Values) {
            if (-not $entry.closed -and $entry.handle -ne $State.job.RootHandle) { $State.job.Release($entry.handle) }
        }
    } finally { $State.job.Dispose() }
}
# Drain redirected root output without retaining unbounded bytes.
function Start-StopOutputDrain($Process) {
    $null=$Process.StandardOutput.BaseStream.CopyToAsync([IO.Stream]::Null)
    $null=$Process.StandardError.BaseStream.CopyToAsync([IO.Stream]::Null)
}
# Opt-in library entrypoint, not connected to the companion/production path.
# Invoke only from a separate trusted observer process with a pinned runner and
# trusted request. OutputDirectory must be a fresh directory under a private ACL.
function Invoke-IndependentStopObserver {
    param($Request,[string]$Executable,[string[]]$Arguments,[string]$WorkingDirectory,[string]$OutputDirectory,[switch]$EnableObserver,[IO.Pipes.AnonymousPipeServerStream[]]$AuthorityChannels=@())
    if (-not $EnableObserver) { throw 'Independent stop observer is disabled.' }
    Assert-CompanionWindows; Assert-StopRequest $Request
    if ($AuthorityChannels.Count -ne 0 -and $AuthorityChannels.Count -ne 2) { throw 'Exactly one authority pipe pair is required.' }
    if ($AuthorityChannels.Count -eq 2 -and ($AuthorityChannels[0].CanRead -or -not $AuthorityChannels[1].CanRead)) { throw 'Authority pipes must be ordered Out then In.' }
    [IntPtr[]]$authorityPipes=@($AuthorityChannels | ForEach-Object { [IntPtr][long]$_.GetClientHandleAsString() })
    $clock=[Diagnostics.Stopwatch]::StartNew(); $started=Get-StopNow; $deadline=Read-StopTime $Request.deadline
    $budget=[long]($deadline-$started).TotalMilliseconds
    if ($budget -le 0 -or $budget -gt 600000) { throw 'Observer deadline outside bound.' }
    $null=Assert-CompanionLocalPath $Executable; $null=Assert-CompanionLocalPath $WorkingDirectory
    $output=Assert-CompanionLocalPath $OutputDirectory
    $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
    try { $sid=$identity.User } finally { $identity.Dispose() }
    $parent=[IO.Directory]::GetParent($output).FullName
    Assert-CompanionPrivateAcl $parent $sid $true
    if ([IO.Directory]::Exists($output) -or [IO.File]::Exists($output)) { throw 'Observer output already exists; no replay permitted.' }
    $directory=New-Object IO.DirectoryInfo($output); $directory.Create((New-CompanionAcl $sid $true))
    # The directory and persistent create-new claim prevent retry after failure.
    $claim=New-CompanionPrivateFile (Join-Path $output 'observer.claim') $sid
    $state=[pscustomobject]@{failed=$false;clock=$clock;budget=$budget;deadline=$deadline;
        job=$null;entries=@{};rootClosed=$false}
    try {
        $state.job=Open-StopBoundary $Executable $Arguments $WorkingDirectory $authorityPipes
        # Successful suspended creation transferred precisely these pipe ends.
        # Close the caller's local client copies before execution, so loss/EOF
        # cannot be masked by an observer-side duplicate.
        foreach ($channel in $AuthorityChannels) { $channel.DisposeLocalCopyOfClientHandle() }
        $root=Read-StopProcess $state $state.job.RootHandle $true
        $state.entries[$root.value.identity.pid]=$root
        # Drain bounded buffers without retaining unbounded runner output. Extra
        # authority pipes are separately and explicitly owned by the caller.
        Start-StopOutputDrain $state.job.RootProcess
        $state.job.RootProcess.StandardInput.Close()
        Assert-StopBudget $state; $state.job.Resume()
        $counts=Wait-StopBoundary $state
        $journal=Read-StopJournal $Request.binding; Assert-StopBudget $state
        $observation=[pscustomobject]@{startedAt=(Format-StopTime $started);observedAt=(Format-StopTime (Get-StopNow));root=$root.value;
            processes=@($state.entries.Values | Where-Object { $_.value.identity.pid -ne $state.job.RootPid } | ForEach-Object { $_.value });
            totalProcesses=[int]$counts.Total;activeProcesses=[int]$counts.Active;limitedProcesses=[int]$counts.Limited}
        $manifest=New-StopManifest $Request $journal $observation; Assert-StopBudget $state
        return Publish-StopManifest $state $output $sid $journal $manifest
    } catch { $state.failed=$true; throw }
    finally { try { Close-StopBoundary $state } finally { $claim.Dispose() } }
}
