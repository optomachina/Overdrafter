#requires -Version 5.1

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
        # Only this retained Process is eligible for cleanup; never find/kill by name.
        try {
            if ($null -ne $result.pid) {
                if (-not $process.HasExited) {
                    $result.terminationRequested = $true
                    $process.Kill()
                    if (-not $process.WaitForExit(5000)) { throw 'Owned child exit remains unknown.' }
                    $result.terminated = $true
                }
                $result.exitCode = $process.ExitCode
            }
        }
        catch { $errors.Add('Cleanup: ' + $_.Exception.Message) }

        # A failed stream must not discard output already available from the other.
        foreach ($stream in @('stdout', 'stderr')) {
            $task = $outTask
            if ($stream -eq 'stderr') { $task = $errTask }
            if ($null -eq $task) { continue }
            try {
                if (-not $task.Wait(5000)) { throw ('Capture did not complete: ' + $stream) }
                $result[$stream] = $task.Result
            }
            catch { $errors.Add('Capture ' + $stream + ': ' + $_.Exception.Message) }
        }
        try { $process.Dispose() }
        catch { $errors.Add('Dispose: ' + $_.Exception.Message) }
        foreach ($stream in @('stdout', 'stderr')) {
            try { [IO.File]::WriteAllText($LogBase + '.' + $stream + '.txt', $result[$stream]) }
            catch { $errors.Add('Log ' + $stream + ': ' + $_.Exception.Message) }
        }
        $timer.Stop()
        $result.elapsedSeconds = $timer.Elapsed.TotalSeconds
        if ($errors.Count -gt 0) { $result.error = [string]::Join(' ', $errors.ToArray()) }
    }
    return $result
}
