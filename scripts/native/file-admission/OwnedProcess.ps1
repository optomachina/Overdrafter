#requires -Version 5.1

# Observes and cleans up only the retained child; never find or kill a process by name.
function Complete-OwnedProcessExit {
    param($Process, $Result, $Errors)
    try {
        if ($null -ne $Result.pid) {
            if (-not $Process.HasExited) {
                $Result.terminationRequested = $true
                $Process.Kill()
                if (-not $Process.WaitForExit(5000)) { throw 'Owned child exit remains unknown.' }
                $Result.terminated = $true
            }
            $Result.exitCode = $Process.ExitCode
        }
    }
    catch { $Errors.Add('Cleanup: ' + $_.Exception.Message) }
}

# Captures each stream independently so one failure cannot discard the other's output.
function Receive-OwnedProcessCapture {
    param($Task, $Stream, $Result, $Errors)
    if ($null -eq $Task) { return }
    try {
        if (-not $Task.Wait(5000)) { throw ('Capture did not complete: ' + $Stream) }
        $Result[$Stream] = $Task.Result
    }
    catch { $Errors.Add('Capture ' + $Stream + ': ' + $_.Exception.Message) }
}

# Persists both observed streams after disposal while retaining independent log failures.
function Write-OwnedProcessLogs {
    param($LogBase, $Result, $Errors)
    foreach ($stream in @('stdout', 'stderr')) {
        try { [IO.File]::WriteAllText($LogBase + '.' + $stream + '.txt', $Result[$stream]) }
        catch { $Errors.Add('Log ' + $stream + ': ' + $_.Exception.Message) }
    }
}
function Set-OwnedProcessStartInfo($Process,[string]$Executable,[string[]]$Arguments,[bool]$RedirectInput) {
    $Process.StartInfo.FileName = $Executable
    $Process.StartInfo.Arguments = ($Arguments | ForEach-Object {
        if ($_ -match '["\r\n]') { throw 'Unsupported process argument.' }
        '"' + $_ + '"'
    }) -join ' '
    $Process.StartInfo.UseShellExecute = $false
    $Process.StartInfo.CreateNoWindow = $true
    $Process.StartInfo.RedirectStandardOutput = $true
    $Process.StartInfo.RedirectStandardError = $true
    $Process.StartInfo.RedirectStandardInput = $RedirectInput
}
function Wait-OwnedProcessExit($Process,$Result,[int]$TimeoutMs) {
    if ($TimeoutMs -lt 1 -or -not $Process.WaitForExit($TimeoutMs)) {
        $Result.timedOut = $true
        $Result.terminationRequested = $true
        $Process.Kill()
        if (-not $Process.WaitForExit(5000)) { throw 'Owned child exit remains unknown.' }
        $Result.terminated = $true
    }
    $Result.exitCode = $Process.ExitCode
}

# Selects the existing default or an internal unstarted retained-process adapter.
function New-OwnedRetainedProcess([scriptblock]$ProcessFactory) {
    if ($null -eq $ProcessFactory) { return New-Object System.Diagnostics.Process }
    return & $ProcessFactory
}

<#
.SYNOPSIS
Runs one retained child and preserves observations even when capture or logging fails.
.DESCRIPTION
Internal qualification helper, not a process-tree sandbox or CAD recovery policy.
ProcessFactory optionally returns exactly one unstarted retained-process wrapper
with StartInfo, Handle, Id, streams, Start, WaitForExit, HasExited, ExitCode, Kill
and Dispose. It is an internal source adapter, never worker input. The default
Diagnostics.Process path remains unchanged; CaptureFactory always runs after Start.
CaptureFactory is an internal fault-injection seam used only by synthetic tests;
normal callers use the child's actual asynchronous stdout/stderr readers.
#>
function Invoke-OwnedProcess {
    [CmdletBinding()]
    param(
        [string]$Executable,
        [string[]]$Arguments,
        [int]$TimeoutMs,
        [string]$LogBase,
        [scriptblock]$CaptureFactory,
        [scriptblock]$RemainingMs,
        [switch]$RedirectInput,
        [scriptblock]$ProcessFactory=$null
    )
    $process = New-OwnedRetainedProcess $ProcessFactory
    $errors = New-Object 'System.Collections.Generic.List[string]'
    $outTask = $null
    $errTask = $null
    $result = [ordered]@{ pid = $null; exitCode = $null; timedOut = $false;
        terminationRequested = $false; terminated = $false;
        elapsedSeconds = $null; error = $null; stdout = ''; stderr = '' }
    $timer = [Diagnostics.Stopwatch]::StartNew()
    try {
        if ($TimeoutMs -le 0 -or $TimeoutMs -gt 600000) {
            throw 'Process timeout must be between 1 and 600000 milliseconds.'
        }
        Set-OwnedProcessStartInfo $process $Executable $Arguments ([bool]$RedirectInput)
        # A journal flush may consume the budget after the caller's earlier
        # check. This callback runs after durable intent, immediately before
        # the only Start call, and again after creation acknowledgment.
        if ($null -ne $RemainingMs) { $TimeoutMs=[int][Math]::Min($TimeoutMs,[int](& $RemainingMs)) }
        if ($TimeoutMs -lt 1) { throw 'Owned child deadline expired before launch.' }
        if (-not $process.Start()) { throw 'Process start returned false.' }
        $result.pid = $process.Id
        if ($null -eq $CaptureFactory) {
            $outTask = $process.StandardOutput.ReadToEndAsync()
            $errTask = $process.StandardError.ReadToEndAsync()
        }
        else {
            $capture = & $CaptureFactory $process
            $outTask = $capture.stdout
            $errTask = $capture.stderr
            if ($outTask -isnot [Threading.Tasks.Task[string]] -or
                $errTask -isnot [Threading.Tasks.Task[string]]) {
                throw 'Capture factory did not return both string tasks.'
            }
        }
        if ($null -ne $RemainingMs) { $TimeoutMs=[int][Math]::Min($TimeoutMs,[int](& $RemainingMs)) }
        Wait-OwnedProcessExit $process $result $TimeoutMs
    }
    catch { $errors.Add($_.Exception.Message) }
    finally {
        Complete-OwnedProcessExit -Process $process -Result $result -Errors $errors
        Receive-OwnedProcessCapture -Task $outTask -Stream 'stdout' -Result $result -Errors $errors
        Receive-OwnedProcessCapture -Task $errTask -Stream 'stderr' -Result $result -Errors $errors
        try { $process.Dispose() }
        catch { $errors.Add('Dispose: ' + $_.Exception.Message) }
        Write-OwnedProcessLogs -LogBase $LogBase -Result $result -Errors $errors
        $timer.Stop()
        $result.elapsedSeconds = $timer.Elapsed.TotalSeconds
        if ($errors.Count -gt 0) { $result.error = [string]::Join(' ', $errors.ToArray()) }
    }
    return $result
}
