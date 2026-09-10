#requires -Version 5.1
# Qualification-only cleanup. The native handle must have been fully identity-
# and live-parent-checked before it is stored in State. Never reopen it by PID.
function Stop-QualificationNative($State) {
    if ($null -eq $State.native -or $null -ne $State.nativeExit) { return }
    try {
        if (-not $State.nativeVerified -or $null -eq $State.workerExit -or $null -eq $State.workerIdentity -or
            $State.nativeParentPid -ne $State.workerIdentity.pid) { throw 'Verified native ownership or prior worker exit is missing.' }
        $identity=Get-RunnerProcessIdentity $State.native $State.nativeIdentity.executablePath
        if ((ConvertTo-JournalJson $identity) -cne (ConvertTo-JournalJson $State.nativeIdentity)) { throw 'Retained native identity changed.' }
        if (-not $State.native.HasExited -and -not $State.nativeStopRequested) {
            $State.nativeStopRequested=$true; $State.native.Kill()
        }
        if (-not $State.native.WaitForExit(30000)) { throw 'Known native exit remains unconfirmed.' }
        $State.nativeExit=$State.native.ExitCode
    } catch { $State.stopErrors.Add('Native cleanup: '+$_.Exception.Message) }
}

# Confirm the directly started worker has exited before touching its verified
# native descendant. Repeated observation never issues another kill request.
function Stop-QualificationWorkerOnly($Worker,$State) {
    try {
        if (-not $Worker.HasExited -and -not $State.workerStopRequested) {
            $State.workerStopRequested=$true; $Worker.Kill()
        }
        if (-not $Worker.WaitForExit(15000)) { throw 'Worker interruption has no confirmed exit.' }
        $State.workerExit=$Worker.ExitCode
    } catch { $State.stopErrors.Add('Worker cleanup: '+$_.Exception.Message) }
}

function Stop-QualificationWorker($Worker,$State) {
    Stop-QualificationWorkerOnly $Worker $State
    if ($null -ne $State.workerExit) { Stop-QualificationNative $State }
}

# Own one directly constructed worker for this fault case. The callback has its
# own bounded checkpoint wait; all termination paths share State. Reuse only the
# passive capture/log helpers, never the generic helper's timeout/kill cleanup.
function Invoke-QualificationWorker($Process,[string]$Executable,[string[]]$Arguments,[string]$LogBase,$State,[scriptblock]$CaptureFactory,[scriptblock]$CleanupFactory=$null) {
    $errors=New-Object 'System.Collections.Generic.List[string]'
    $outTask=$null; $errTask=$null; $started=$false
    $result=[ordered]@{pid=$null;exitCode=$null;timedOut=$false;terminationRequested=$false;terminated=$false;
        elapsedSeconds=$null;error=$null;stdout='';stderr=''}
    $timer=[Diagnostics.Stopwatch]::StartNew()
    try {
        $Process.StartInfo.FileName=$Executable
        $Process.StartInfo.Arguments=($Arguments | ForEach-Object {
            if ($_ -match '["\r\n]') { throw 'Unsupported process argument.' }
            '"'+$_+'"'
        }) -join ' '
        $Process.StartInfo.UseShellExecute=$false
        $Process.StartInfo.CreateNoWindow=$true
        $Process.StartInfo.RedirectStandardOutput=$true
        $Process.StartInfo.RedirectStandardError=$true
        if (-not $Process.Start()) { throw 'Qualification worker start returned false.' }
        $started=$true; $result.pid=$Process.Id
        # Start each reader here so callback failures cannot hide an earlier
        # successful reader. The callback only controls the checkpoint and stop.
        $outTask=$Process.StandardOutput.ReadToEndAsync()
        $errTask=$Process.StandardError.ReadToEndAsync()
        & $CaptureFactory $Process | Out-Null
    } catch { $errors.Add($_.Exception.Message) }
    finally {
        if ($started) {
            try {
                if ($null -eq $CleanupFactory) { Stop-QualificationWorker $Process $State }
                else { & $CleanupFactory $Process $State | Out-Null }
            } catch { $State.stopErrors.Add('Qualification cleanup: '+$_.Exception.Message) }
            $result.exitCode=$State.workerExit
            $result.terminationRequested=$State.workerStopRequested
            $result.terminated=$State.workerStopRequested -and $null -ne $State.workerExit
        }
        foreach ($message in $State.stopErrors) { $errors.Add($message) }
        Receive-OwnedProcessCapture $outTask 'stdout' $result $errors
        Receive-OwnedProcessCapture $errTask 'stderr' $result $errors
        try { $Process.Dispose() } catch { $errors.Add('Dispose: '+$_.Exception.Message) }
        Write-OwnedProcessLogs $LogBase $result $errors
        $timer.Stop(); $result.elapsedSeconds=$timer.Elapsed.TotalSeconds
        if ($errors.Count -gt 0) { $result.error=[string]::Join(' ', $errors.ToArray()) }
    }
    return $result
}
