#requires -Version 5.1
<#
.SYNOPSIS
Compiles and runs synthetic file-predicate cases on Windows without CAD access.
.DESCRIPTION
Preserves one private attempt directory containing copied source, logs, fixtures
and a diagnostic receipt. Uses only the installed x64 .NET Framework compiler.
SourceCommit is an optional caller provenance label; recorded source hashes
identify actual inputs. This script does not verify Git membership or grant authority.
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

# The retained Process instance identifies the child; never find/kill by name.
function Invoke-OwnedProcess {
    param([string]$Executable, [string[]]$Arguments, [int]$TimeoutMs, [string]$LogBase)
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo.FileName = $Executable
    $process.StartInfo.Arguments = ($Arguments | ForEach-Object {
        if ($_ -match '["\r\n]') { throw 'Unsupported process argument.' }
        '"' + $_ + '"'
    }) -join ' '
    $process.StartInfo.UseShellExecute = $false
    $process.StartInfo.CreateNoWindow = $true
    $process.StartInfo.RedirectStandardOutput = $true
    $process.StartInfo.RedirectStandardError = $true
    $result = [ordered]@{ pid = $null; exitCode = $null; timedOut = $false;
        terminationRequested = $false; terminated = $false;
        elapsedSeconds = $null; error = $null; stdout = ''; stderr = '' }
    $timer = [Diagnostics.Stopwatch]::StartNew()
    try {
        if (-not $process.Start()) { throw 'Process start returned false.' }
        $result.pid = $process.Id
        $outTask = $process.StandardOutput.ReadToEndAsync()
        $errTask = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit($TimeoutMs)) {
            $result.timedOut = $true
            $result.terminationRequested = $true
            $process.Kill()
            if (-not $process.WaitForExit(5000)) { throw 'Owned child exit remains unknown.' }
            $result.terminated = $true
        }
        $result.exitCode = $process.ExitCode
        if (-not $outTask.Wait(5000) -or -not $errTask.Wait(5000)) {
            throw 'Child exited but output capture did not complete.'
        }
        $result.stdout = $outTask.Result
        $result.stderr = $errTask.Result
    }
    catch { $result.error = $_.Exception.Message }
    finally {
        # Capture/start failures must not abandon an owned compiler or test child.
        try {
            if ($null -ne $result.pid -and -not $process.HasExited) {
                $result.terminationRequested = $true
                $process.Kill()
                if (-not $process.WaitForExit(5000)) { throw 'Owned child exit remains unknown.' }
                $result.terminated = $true
                $result.exitCode = $process.ExitCode
            }
        }
        catch { $result.error = [string]$result.error + ' Cleanup: ' + $_.Exception.Message }
        $timer.Stop()
        $result.elapsedSeconds = $timer.Elapsed.TotalSeconds
        $process.Dispose()
        [IO.File]::WriteAllText($LogBase + '.stdout.txt', $result.stdout)
        [IO.File]::WriteAllText($LogBase + '.stderr.txt', $result.stderr)
    }
    return $result
}

$root = [IO.Path]::GetFullPath($OutputRoot)
[IO.Directory]::CreateDirectory($root) | Out-Null
$attempt = Join-Path $root ('file-admission-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $attempt -ErrorAction Stop | Out-Null
$receipt = [ordered]@{ outcome = 'failed'; fileOnly = $true; nativeCalls = 0;
    qualification = 'incomplete'; sourceCommit = $null;
    startedUtc = [DateTime]::UtcNow.ToString('o'); sourceHashes = @();
    finishedUtc = $null; binarySha256 = $null;
    compiler = $null; compile = $null; test = $null; cases = $null; error = $null }
$exitCode = 1
if (-not [String]::IsNullOrEmpty($SourceCommit)) { $receipt.sourceCommit = $SourceCommit }
try {
    $compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
    if (-not (Test-Path -LiteralPath $compiler -PathType Leaf)) {
        throw 'Installed x64 .NET Framework compiler is unavailable; nothing installed.'
    }
    $receipt.compiler = @{ path = $compiler; version = (Get-Item -LiteralPath $compiler).VersionInfo.FileVersion;
        sha256 = (Get-FileHash -LiteralPath $compiler -Algorithm SHA256).Hash.ToLowerInvariant() }
    $sources = @()
    foreach ($name in @('SharedFilePredicates.cs', 'FileAdmissionCases.cs', 'qualify.ps1')) {
        $source = Join-Path $PSScriptRoot $name
        $destination = Join-Path $attempt $name
        $digest = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant()
        Copy-Item -LiteralPath $source -Destination $destination -ErrorAction Stop
        if ((Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant() -ne $digest) {
            throw 'Source copy digest mismatch.'
        }
        $receipt.sourceHashes += @{ name = $name; sha256 = $digest }
        if ($name.EndsWith('.cs')) { $sources += $destination }
    }
    $exe = Join-Path $attempt 'FileAdmissionCases.exe'
    $compileArgs = @('/nologo', '/target:exe', '/platform:x64', '/optimize+',
        '/reference:System.dll', '/reference:System.Core.dll', '/reference:System.Web.Extensions.dll', ('/out:' + $exe)) + $sources
    $receipt.compile = Invoke-OwnedProcess $compiler $compileArgs 30000 (Join-Path $attempt 'compile')
    if ($receipt.compile.error -or $receipt.compile.timedOut -or $receipt.compile.exitCode -ne 0) {
        throw 'Compilation did not succeed; test was not started.'
    }
    $receipt.binarySha256 = (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant()
    $fixtures = Join-Path $attempt 'fixtures'
    New-Item -ItemType Directory -Path $fixtures -ErrorAction Stop | Out-Null
    $receipt.test = Invoke-OwnedProcess $exe @($fixtures) 60000 (Join-Path $attempt 'test')
    if ($receipt.test.error -or $receipt.test.timedOut -or $receipt.test.exitCode -ne 0) {
        throw 'Synthetic cases did not exit successfully.'
    }
    $receipt.cases = $receipt.test.stdout | ConvertFrom-Json
    if ($receipt.cases.outcome -ne 'passed' -or $receipt.cases.nativeCalls -ne 0 -or
        $receipt.cases.fileOnly -ne $true -or $receipt.cases.sourceOriginalHashesUnchanged -ne $true -or
        $receipt.cases.cases.Count -ne 5) {
        throw 'Synthetic case receipt is incomplete or failed.'
    }
    $receipt.outcome = 'passed'
    $exitCode = 0
}
catch { $receipt.error = $_.Exception.Message }
finally {
    $receipt.finishedUtc = [DateTime]::UtcNow.ToString('o')
    $receiptPath = Join-Path $attempt 'result.json'
    $receipt | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $receiptPath -Encoding UTF8
    Write-Output $receiptPath
}
exit $exitCode
