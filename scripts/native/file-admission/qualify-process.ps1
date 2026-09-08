#requires -Version 5.1
<#
.SYNOPSIS
Exercises the actual owned-process helper with bounded synthetic Windows children.
.DESCRIPTION
Preserves source, compiler, binary, logs and individual adverse-case observations.
Injected capture failures are test seams, not observed OS pipe faults. No CAD calls.
#>
[CmdletBinding()]
param(
    [ValidatePattern('^[0-9a-f]{40}$')]
    [string]$SourceCommit,
    [Parameter(Mandatory = $true)]
    [string]$OutputRoot
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or
    -not [Environment]::Is64BitProcess) {
    throw 'Run with 64-bit PowerShell on Windows; no test was executed.'
}
if ($OutputRoot -match '["\r\n]') { throw 'Unsupported output root.' }
$root = [IO.Path]::GetFullPath($OutputRoot)
[IO.Directory]::CreateDirectory($root) | Out-Null
$attempt = Join-Path $root ('owned-process-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $attempt -ErrorAction Stop | Out-Null
$receipt = [ordered]@{ outcome = 'failed'; processOnly = $true; nativeCalls = 0;
    qualification = 'incomplete'; sourceCommit = $null;
    startedUtc = [DateTime]::UtcNow.ToString('o'); finishedUtc = $null;
    sourceHashes = @(); compiler = $null; compile = $null; binarySha256 = $null;
    cases = @(); control = $null; error = $null }
if (-not [string]::IsNullOrEmpty($SourceCommit)) { $receipt.sourceCommit = $SourceCommit }
$control = New-Object Diagnostics.Process
$controlStarted = $false
$release = Join-Path $attempt 'control.release'
$exitCode = 1

function Get-TextDigest([string]$Text) {
    $hasher = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($hasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($Text)))).Replace('-', '').ToLowerInvariant() }
    finally { $hasher.Dispose() }
}

# Assertions consume actual helper receipts; large output stays in private logs.
function Add-ProcessCase {
    param([string]$Name, $Record, [bool[]]$Checks, [bool]$ExpectedSuccess, [bool]$Injected = $false)
    $survived = -not $control.HasExited
    $succeeded = -not $Record.error -and -not $Record.timedOut -and $Record.exitCode -eq 0
    $passed = $survived -and ($succeeded -eq $ExpectedSuccess) -and
        ($null -eq $Record.pid -or $Record.pid -ne $control.Id) -and
        $Record.elapsedSeconds -gt 0 -and $Record.elapsedSeconds -lt 20
    foreach ($check in $Checks) { if (-not $check) { $passed = $false } }
    $observed = [ordered]@{}
    foreach ($key in @('pid', 'exitCode', 'timedOut', 'terminationRequested', 'terminated', 'elapsedSeconds', 'error')) {
        $observed[$key] = $Record[$key]
    }
    $observed.stdoutLength = $Record.stdout.Length
    $observed.stderrLength = $Record.stderr.Length
    $observed.stdoutSha256 = Get-TextDigest $Record.stdout
    $observed.stderrSha256 = Get-TextDigest $Record.stderr
    $receipt.cases += [ordered]@{ name = $Name; passed = $passed; injectedCaptureFault = $Injected;
        invocationSucceeded = $succeeded; controlSurvived = $survived; observed = $observed }
    if (-not $passed) { throw ('Process case failed: ' + $Name) }
}

try {
    foreach ($name in @('OwnedProcess.ps1', 'ProcessProbe.cs', 'qualify-process.ps1')) {
        $source = Join-Path $PSScriptRoot $name
        $destination = Join-Path $attempt $name
        $digest = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant()
        Copy-Item -LiteralPath $source -Destination $destination -ErrorAction Stop
        if ((Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant() -ne $digest) {
            throw 'Source copy digest mismatch.'
        }
        $receipt.sourceHashes += @{ name = $name; sha256 = $digest }
    }
    . (Join-Path $attempt 'OwnedProcess.ps1')
    $compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
    if (-not (Test-Path -LiteralPath $compiler -PathType Leaf)) { throw 'Installed x64 compiler unavailable; nothing installed.' }
    $receipt.compiler = @{ path = $compiler; version = (Get-Item -LiteralPath $compiler).VersionInfo.FileVersion;
        sha256 = (Get-FileHash -LiteralPath $compiler -Algorithm SHA256).Hash.ToLowerInvariant() }
    $exe = Join-Path $attempt 'ProcessProbe.exe'
    $compileArgs = @('/nologo', '/target:exe', '/platform:x64', '/optimize+',
        '/reference:System.dll', '/reference:System.Core.dll', ('/out:' + $exe),
        (Join-Path $attempt 'ProcessProbe.cs'))
    $receipt.compile = Invoke-OwnedProcess $compiler $compileArgs 30000 (Join-Path $attempt 'compile')
    if ($receipt.compile.error -or $receipt.compile.timedOut -or $receipt.compile.exitCode -ne 0) {
        throw 'Probe compilation failed; process cases were not started.'
    }
    $receipt.binarySha256 = (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant()

    $ready = Join-Path $attempt 'control.ready'
    $control.StartInfo.FileName = $exe
    $control.StartInfo.Arguments = 'control "' + $ready + '" "' + $release + '"'
    $control.StartInfo.UseShellExecute = $false
    $control.StartInfo.CreateNoWindow = $true
    if (-not $control.Start()) { throw 'Control start returned false.' }
    $controlStarted = $true
    $receipt.control = [ordered]@{ pid = $control.Id; ready = $false; released = $false;
        exitCode = $null; terminationRequested = $false; error = $null }
    $readyTimer = [Diagnostics.Stopwatch]::StartNew()
    while (-not [IO.File]::Exists($ready) -and -not $control.HasExited -and $readyTimer.ElapsedMilliseconds -lt 5000) {
        Start-Sleep -Milliseconds 20
    }
    $readyTimer.Stop()
    if (-not [IO.File]::Exists($ready) -or $control.HasExited) { throw 'Control readiness was not established.' }
    $receipt.control.ready = $true

    $record = Invoke-OwnedProcess $exe @('flood') 5000 (Join-Path $attempt 'flood')
    $outExpected = 'OUT:' + [string]::new([char]'O', 131072) + ':END' + [Environment]::NewLine
    $errExpected = 'ERR:' + [string]::new([char]'E', 131072) + ':END' + [Environment]::NewLine
    Add-ProcessCase 'successful_capture' $record @(
        ($null -ne $record.pid), ($record.stdout -ceq $outExpected),
        ($record.stderr -ceq $errExpected), (-not $record.terminationRequested)
    ) $true

    $record = Invoke-OwnedProcess $exe @('exit23') 5000 (Join-Path $attempt 'nonzero')
    Add-ProcessCase 'nonzero_exit' $record @(
        ($record.exitCode -eq 23), ($null -eq $record.error), (-not $record.terminationRequested),
        ($record.stdout -ceq ('exit23-out' + [Environment]::NewLine)),
        ($record.stderr -ceq ('exit23-err' + [Environment]::NewLine))
    ) $false

    $record = Invoke-OwnedProcess (Join-Path $attempt 'missing.exe') @() 1000 (Join-Path $attempt 'missing')
    Add-ProcessCase 'missing_executable' $record @(
        ($null -eq $record.pid), ($null -eq $record.exitCode), ([bool]$record.error),
        (-not $record.terminationRequested)
    ) $false

    $record = Invoke-OwnedProcess $exe @('bad"argument') 1000 (Join-Path $attempt 'argument')
    Add-ProcessCase 'invalid_argument' $record @(
        ($null -eq $record.pid), ($null -eq $record.exitCode),
        ($record.error -like '*Unsupported process argument*'), (-not $record.terminationRequested)
    ) $false

    $record = Invoke-OwnedProcess $exe @('sleep') 0 (Join-Path $attempt 'invalid-timeout')
    Add-ProcessCase 'invalid_timeout' $record @(
        ($null -eq $record.pid), ($null -eq $record.exitCode),
        ($record.error -like '*timeout must be*'), (-not $record.terminationRequested)
    ) $false

    $record = Invoke-OwnedProcess $exe @('sleep') 1000 (Join-Path $attempt 'timeout')
    Add-ProcessCase 'owned_timeout' $record @(
        $record.timedOut, $record.terminationRequested, $record.terminated,
        ($null -ne $record.exitCode), ($record.exitCode -ne 0)
    ) $false

    $fault = { param($child) throw 'Injected capture startup failure.' }
    $record = Invoke-OwnedProcess $exe @('sleep') 1000 (Join-Path $attempt 'capture-start') -CaptureFactory $fault
    Add-ProcessCase 'capture_start_failure' $record @(
        ($record.error -like '*Injected capture startup failure*'), (-not $record.timedOut),
        $record.terminationRequested, $record.terminated, ($null -ne $record.exitCode)
    ) $false $true

    $never = New-Object 'System.Threading.Tasks.TaskCompletionSource[string]'
    $fault = { param($child)
        return @{ stdout = $child.StandardOutput.ReadToEndAsync(); stderr = $never.Task }
    }.GetNewClosure()
    try { $record = Invoke-OwnedProcess $exe @('quick') 5000 (Join-Path $attempt 'capture-wait') -CaptureFactory $fault }
    finally { $null = $never.TrySetCanceled() }
    Add-ProcessCase 'capture_wait_timeout' $record @(
        ($record.exitCode -eq 0), ($record.stdout -ceq 'quick-out'),
        ($record.stderr -ceq ''), ($record.error -like '*Capture did not complete: stderr*'),
        (-not $record.timedOut), (-not $record.terminationRequested)
    ) $false $true

    $blockedLog = Join-Path $attempt 'blocked-log'
    New-Item -ItemType Directory -Path ($blockedLog + '.stdout.txt') -ErrorAction Stop | Out-Null
    $record = Invoke-OwnedProcess $exe @('quick') 5000 $blockedLog
    Add-ProcessCase 'log_write_failure' $record @(
        ($null -ne $record.pid), ($record.exitCode -eq 0), ($record.error -like '*Log stdout:*'),
        ($record.stdout -ceq 'quick-out'), ($record.stderr -ceq 'quick-err'),
        (-not $record.terminationRequested)
    ) $false
    if ($receipt.cases.Count -ne 9) { throw 'Process case set is incomplete.' }
    [IO.File]::WriteAllText($release, 'release')
    $receipt.control.released = $true
    if (-not $control.WaitForExit(5000)) { throw 'Control did not exit after release.' }
    $receipt.control.exitCode = $control.ExitCode
    if ($control.ExitCode -ne 0) { throw 'Control exit was not successful.' }
    $receipt.outcome = 'passed'
    $exitCode = 0
}
catch { $receipt.error = $_.Exception.Message }
finally {
    if ($controlStarted) {
        $controlErrors = New-Object 'System.Collections.Generic.List[string]'
        try {
            if (-not $control.HasExited) {
                try {
                    [IO.File]::WriteAllText($release, 'release')
                    $receipt.control.released = $true
                }
                catch { $controlErrors.Add('Release: ' + $_.Exception.Message) }
                if (-not $receipt.control.released -or -not $control.WaitForExit(5000)) {
                    $receipt.control.terminationRequested = $true
                    $control.Kill()
                    if (-not $control.WaitForExit(5000)) { throw 'Control exit remains unknown.' }
                    $controlErrors.Add('Control required forced termination.')
                }
            }
        }
        catch { $controlErrors.Add('Cleanup: ' + $_.Exception.Message) }
        try {
            if ($control.HasExited) { $receipt.control.exitCode = $control.ExitCode }
            else { $controlErrors.Add('Control exit remains unknown.') }
        }
        catch { $controlErrors.Add('Exit observation: ' + $_.Exception.Message) }
        if ($controlErrors.Count -gt 0) {
            $receipt.control.error = [string]::Join(' ', $controlErrors.ToArray())
            $receipt.outcome = 'failed'
            $exitCode = 1
        }
    }
    $control.Dispose()
    $receipt.finishedUtc = [DateTime]::UtcNow.ToString('o')
    $receiptPath = Join-Path $attempt 'result.json'
    $receipt | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $receiptPath -Encoding UTF8
    Write-Output $receiptPath
}
exit $exitCode
