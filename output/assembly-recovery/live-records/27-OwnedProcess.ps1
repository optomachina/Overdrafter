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

<#
.SYNOPSIS
Runs one retained child and preserves observations even when capture or logging fails.
.DESCRIPTION
Internal qualification helper, not a process-tree sandbox or CAD recovery policy.
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
        [scriptblock]$CaptureFactory
    )
    $process = New-Object System.Diagnostics.Process
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
        $process.StartInfo.FileName = $Executable
        $process.StartInfo.Arguments = ($Arguments | ForEach-Object {
            if ($_ -match '["\r\n]') { throw 'Unsupported process argument.' }
            '"' + $_ + '"'
        }) -join ' '
        $process.StartInfo.UseShellExecute = $false
        $process.StartInfo.CreateNoWindow = $true
        $process.StartInfo.RedirectStandardOutput = $true
        $process.StartInfo.RedirectStandardError = $true
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
        if (-not $process.WaitForExit($TimeoutMs)) {
            $result.timedOut = $true
            $result.terminationRequested = $true
            $process.Kill()
            if (-not $process.WaitForExit(5000)) { throw 'Owned child exit remains unknown.' }
            $result.terminated = $true
        }
        $result.exitCode = $process.ExitCode
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
