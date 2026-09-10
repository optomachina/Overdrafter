#requires -Version 5.1
# Qualification-only process control. Receipt validation precedes these helpers;
# ownership still requires independent live handle, executable and parent checks.
. (Join-Path $PSScriptRoot 'CrashController.ps1')
. (Join-Path $PSScriptRoot 'NativeCallAcknowledgment.ps1')

function New-NativeCallControllerState {
    return [pscustomobject]@{workerIdentity=$null;workerExit=$null;workerStopRequested=$false;
        helper=$null;helperIdentity=$null;helperParentPid=$null;helperVerified=$false;helperExit=$null;helperStopRequested=$false;
        native=$null;nativeIdentity=$null;nativeParentPid=$null;nativeVerified=$false;nativeExit=$null;nativeStopRequested=$false;
        stopErrors=(New-Object 'System.Collections.Generic.List[string]')}
}

# These two narrow OS seams are replaced only by inert regression tests. Never
# use this lookup from cleanup: cleanup operates on the previously retained handle.
function Open-NativeCallProcess([int]$ProcessId) { return [Diagnostics.Process]::GetProcessById($ProcessId) }
function Get-NativeCallParent([int]$ProcessId) {
    $parents=@(Get-CimInstance Win32_Process -Filter ('ProcessId = '+$ProcessId) -ErrorAction Stop)
    if ($parents.Count -ne 1) { throw 'Native call parent observation is unavailable.' }
    return [int]$parents[0].ParentProcessId
}

# Retain one exact descendant while its directly started owner is still alive.
# Commit it to State only after every check passes; failed lookups are disposed
# without termination. Earlier verified descendants remain available for cleanup.
function Set-NativeCallDescendant($Worker,$State,$Checkpoint,[ValidateSet('helper','native')][string]$Role) {
    if ($null -eq $State.workerIdentity -or $null -ne $State.$Role -or $Worker.HasExited) { throw 'Live call ownership is unavailable or already captured.' }
    $owner=Get-RunnerProcessIdentity $Worker $State.workerIdentity.executablePath
    if ((ConvertTo-JournalJson $owner) -cne (ConvertTo-JournalJson $State.workerIdentity)) { throw 'Retained call worker identity changed.' }
    $expected=[pscustomobject]@{pid=$Checkpoint.($Role+'Pid');creationTicks=$Checkpoint.($Role+'CreationTicks');
        sessionId=$Checkpoint.sessionId;executablePath=$Checkpoint.($Role+'Path')}
    Assert-JournalProcessIdentity $expected
    Assert-JournalPath $expected.executablePath
    Assert-JournalDigest $Checkpoint.($Role+'Sha256')
    if ($expected.pid -eq $owner.pid -or $expected.sessionId -ne $owner.sessionId -or
        [long]$expected.creationTicks -lt [long]$owner.creationTicks) { throw 'Call descendant lies outside its owner.' }
    $candidate=Open-NativeCallProcess $expected.pid
    try {
        $identity=Get-RunnerProcessIdentity $candidate $expected.executablePath
        if ($candidate.HasExited -or $identity.pid -ne $expected.pid -or $identity.creationTicks -cne $expected.creationTicks -or
            $identity.sessionId -ne $expected.sessionId -or
            -not [string]::Equals($identity.executablePath,$expected.executablePath,[StringComparison]::OrdinalIgnoreCase) -or
            (Get-PreparedHash $identity.executablePath) -cne $Checkpoint.($Role+'Sha256')) { throw 'Call descendant does not match the live process.' }
        $parent=Get-NativeCallParent $identity.pid
        if ($parent -ne $owner.pid -or $Worker.HasExited -or $candidate.HasExited) { throw 'Call descendant is not a child of the live worker.' }
        $State.($Role+'Identity')=$identity; $State.($Role+'ParentPid')=$parent
        $State.($Role+'Verified')=$true; $State.$Role=$candidate; $candidate=$null
    } finally { if ($null -ne $candidate) { $candidate.Dispose() } }
}

# The callback holds for 60 s. Admit interruption only during its first 10 s,
# with a monotonic observation budget as well as wall-clock receipt freshness.
# Recheck immediately before interruption; absence of a release file alone is
# never evidence that the callback is still active.
function Get-NativeCallUtcNow { return [DateTimeOffset]::UtcNow }
function Assert-NativeCallFreshness($Checkpoint,[string]$ReleasedPath,$CaptureClock) {
    $elapsed=$CaptureClock.ElapsedMilliseconds
    if ($elapsed -lt 0 -or $elapsed -ge 10000 -or $Checkpoint.phase -cne 'entered' -or $Checkpoint.pauseMs -ne 60000) { throw 'Native call interruption window expired.' }
    $at=[DateTimeOffset]::ParseExact($Checkpoint.utc,"yyyy-MM-dd'T'HH:mm:ss.fffffff'Z'",[Globalization.CultureInfo]::InvariantCulture,
        [Globalization.DateTimeStyles]::AssumeUniversal)
    $age=((Get-NativeCallUtcNow)-$at).TotalMilliseconds
    if ($age -lt 0 -or $age -ge 10000 -or (Test-Path -LiteralPath $ReleasedPath -ErrorAction Stop)) { throw 'Native call receipt is future, released or too old.' }
}
function Assert-NativeCallActive($Checkpoint,$State,$Worker,[string]$ReleasedPath,$CaptureClock) {
    Assert-NativeCallFreshness $Checkpoint $ReleasedPath $CaptureClock
    if ($Worker.HasExited -or $null -eq $State.workerIdentity -or $State.workerStopRequested -or
        $null -ne $State.workerExit -or $State.stopErrors.Count -ne 0) { throw 'Call worker is no longer eligible for interruption.' }
    $owner=Get-RunnerProcessIdentity $Worker $State.workerIdentity.executablePath
    if ((ConvertTo-JournalJson $owner) -cne (ConvertTo-JournalJson $State.workerIdentity)) { throw 'Retained call worker identity changed.' }
    foreach ($role in @('helper','native')) {
        if (-not $State.($role+'Verified') -or $null -eq $State.$role -or $State.$role.HasExited -or
            $State.($role+'StopRequested') -or $null -ne $State.($role+'Exit') -or
            $State.($role+'ParentPid') -ne $owner.pid) { throw 'Call descendant is no longer eligible for interruption.' }
        $identity=Get-RunnerProcessIdentity $State.$role $State.($role+'Identity').executablePath
        if ((ConvertTo-JournalJson $identity) -cne (ConvertTo-JournalJson $State.($role+'Identity'))) { throw 'Retained call descendant identity changed.' }
    }
    # Identity queries can stall. Sample both clocks again after the last query,
    # then reject an expired/released callback before returning stop eligibility.
    Assert-NativeCallFreshness $Checkpoint $ReleasedPath $CaptureClock
}

# Callback arrival can race its owner's durable creation acknowledgment. Keep
# the already verified handles for cleanup, but never widen the 10-second window.
function Wait-NativeCallAcknowledgment([string]$Path,$Checkpoint,$Binding,$State,$Worker,[string]$ReleasedPath,$CaptureClock) {
    while ($true) {
        Assert-NativeCallActive $Checkpoint $State $Worker $ReleasedPath $CaptureClock
        if (Test-Path -LiteralPath $Path -ErrorAction Stop) {
            $acknowledgment=Read-PreparedJournalSupervisor $Path
            Assert-NativeCallAcknowledgment $acknowledgment $Checkpoint $Binding $State.workerIdentity
            Assert-NativeCallActive $Checkpoint $State $Worker $ReleasedPath $CaptureClock
            return $acknowledgment
        }
        Start-Sleep -Milliseconds 100
    }
}

# Called only after a confirmed worker exit; retain each helper cleanup error.
function Stop-NativeCallHelper($State) {
    try {
        if (-not $State.helperVerified -or $null -eq $State.workerIdentity -or
            $State.helperParentPid -ne $State.workerIdentity.pid) { throw 'Verified helper ownership is missing.' }
        $identity=Get-RunnerProcessIdentity $State.helper $State.helperIdentity.executablePath
        if ((ConvertTo-JournalJson $identity) -cne (ConvertTo-JournalJson $State.helperIdentity)) { throw 'Retained helper identity changed.' }
        if (-not $State.helper.HasExited -and -not $State.helperStopRequested) {
            $State.helperStopRequested=$true; $State.helper.Kill()
        }
        if (-not $State.helper.WaitForExit(15000)) { throw 'Known helper exit remains unconfirmed.' }
        $State.helperExit=$State.helper.ExitCode
    } catch { $State.stopErrors.Add('Helper cleanup: '+$_.Exception.Message) }
}

# The owner must stop first so it cannot launch more work. The COM caller must
# then stop before SolidWorks. Missing helper identity/exit blocks native cleanup;
# no PID lookup or name-based stop is permitted, even on failure paths.
function Stop-NativeCallWorker($Worker,$State) {
    Stop-QualificationWorkerOnly $Worker $State
    if ($null -eq $State.workerExit) { return }
    if ($null -ne $State.helper -and $null -eq $State.helperExit) {
        Stop-NativeCallHelper $State
    }
    if ($null -ne $State.native) {
        if (-not $State.helperVerified -or $null -eq $State.helperExit) {
            $State.stopErrors.Add('Native cleanup blocked by missing verified helper exit.'); return
        }
        Stop-QualificationNative $State
    }
}
