#requires -Version 5.1
<#
.SYNOPSIS
Qualifies an empty lifecycle or one explicitly opted-in synthetic read-only interruption.
.DESCRIPTION
Default-off. PID zero with empty ticks requires no existing native process. Otherwise
the caller pins the existing empty session before its normal ExitApp request.
SourceCommit is an optional provenance label, not proof of Git membership.
#>
[CmdletBinding()]
param(
    [switch]$Execute,
    [Parameter(Mandatory = $true)][string]$OutputRoot,
    [Parameter(Mandatory = $true)][ValidateRange(0, 2147483647)][int]$ExpectedOldPid,
    [AllowEmptyString()][string]$ExpectedOldTicks = '',
    [string]$SourceCommit,
    [switch]$InterruptReadonly,
    [string]$BaselinePath,
    [string]$CandidatePath
)
if (-not $Execute) { throw 'Default-off: explicit -Execute and expected old identity required.' }
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($OutputRoot) -or $OutputRoot -match '["\r\n]') { throw 'Unsupported output root.' }
$folder = Join-Path ([IO.Path]::GetFullPath($OutputRoot)) ('session-' + [Guid]::NewGuid().ToString('N'))
if ($folder.Length -gt 120) { throw 'Use a shorter output root; attempt directory must not exceed 120 characters.' }
New-Item -ItemType Directory -Path $folder -ErrorAction Stop | Out-Null
$resultPath = Join-Path $folder 'lifecycle-result.json'
$exe = 'C:\Program Files\SOLIDWORKS 2022\SOLIDWORKS\SLDWORKS.exe'
$exeHash = '6384c0829bac149831be5fdc9e705c90612273d25b46fdff5e5760d11e22d6cc'
$interop = 'C:\Program Files\SOLIDWORKS 2022\SOLIDWORKS\api\redist\SolidWorks.Interop.sldworks.dll'
$helper = Join-Path $folder 'NativeSessionProbe.exe'
$r = [ordered]@{ utc = [DateTime]::UtcNow.ToString('o'); outcome = 'in_progress'; stage = 'preflight';
    caller = @{ execute = $Execute.IsPresent; expectedOldPid = $ExpectedOldPid; expectedOldTicks = $ExpectedOldTicks;
        interruptReadonly = $InterruptReadonly.IsPresent };
    oldOwned = $false; nativeStartAttempted = $false; nativeCloseAttempted = $false; nativeStarted = $false; nativeExit = $null;
    recovery_required = $false; error = $null; observations = @(); qualification = 'incomplete';
    sourceCommit = $null; sourceHashes = @(); compiler = $null; compile = $null; binarySha256 = $null }
$old = $null; $native = $null
$previousDirectory = [Environment]::CurrentDirectory

function Save-Receipt { $r | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $resultPath -Encoding UTF8 }
function Add-Failure($Message) {
    $r.outcome = 'failed'
    if ($r.nativeStartAttempted -or $r.nativeCloseAttempted) { $r.recovery_required = $true }
    if ($r.error) { $r.error += ' ' + $Message } else { $r.error = $Message }
}
# Retaining the actual OS handle prevents PID reuse from substituting another child.
function Read-Identity($Process) {
    $null = $Process.Handle
    return [ordered]@{ pid = $Process.Id; ticks = $Process.StartTime.ToUniversalTime().Ticks.ToString();
        session = $Process.SessionId; path = $Process.MainModule.FileName }
}
function Assert-NoNative($Reason) {
    $all = @(Get-Process SLDWORKS -ErrorAction SilentlyContinue)
    try { if ($all.Count -ne 0) { throw $Reason } }
    finally { foreach ($process in $all) { $process.Dispose() } }
}
function Assert-NativeBinary {
    $version = [Diagnostics.FileVersionInfo]::GetVersionInfo($exe)
    if ($version.FileVersion -ne '30.5.0.0049' -or $version.ProductVersion -ne '30.5.0.0049' -or
        (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant() -ne $exeHash) { throw 'native binary mismatch' }
}
function Assert-Identity($Process, $Identity) {
    $all = @(Get-Process SLDWORKS -ErrorAction SilentlyContinue)
    try {
        if ($all.Count -ne 1 -or $all[0].Id -ne $Identity.pid -or $Process.HasExited) { throw 'singleton or exit mismatch' }
        $now = Read-Identity $Process
        if ($now.pid -ne $Identity.pid -or $now.ticks -cne $Identity.ticks -or
            $now.session -ne $Identity.session -or $now.session -ne [Diagnostics.Process]::GetCurrentProcess().SessionId -or
            $now.path -ine $exe) { throw 'native identity mismatch' }
        Assert-NativeBinary
    } finally { foreach ($process in $all) { $process.Dispose() } }
}
function Assert-CallerBinding {
    if ($InterruptReadonly -and ($ExpectedOldPid -ne 0 -or [string]::IsNullOrWhiteSpace($BaselinePath) -or
        [string]::IsNullOrWhiteSpace($CandidatePath))) { throw 'Interruption requires PID zero and both pinned synthetic source paths.' }
    if (-not $InterruptReadonly -and ($BaselinePath -or $CandidatePath)) { throw 'Fixture paths require -InterruptReadonly.' }
    if ($ExpectedOldPid -eq 0) {
        if ($ExpectedOldTicks -cne '') { throw 'PID zero requires empty expected ticks.' }
        Assert-NoNative 'PID zero requires no existing native process.'
        return
    }
    $ticks = [long]0
    if ($ExpectedOldTicks -notmatch '^[1-9][0-9]{0,18}$' -or -not [long]::TryParse($ExpectedOldTicks, [ref]$ticks) -or
        $ticks -gt [DateTime]::MaxValue.Ticks) { throw 'Expected old ticks must be a canonical positive DateTime tick count.' }
}
# Copy all executable source inputs into the fresh attempt and retain their actual hashes.
function Copy-LifecycleSources {
    $sources = @((Join-Path $PSScriptRoot 'lifecycle.ps1'), (Join-Path $PSScriptRoot 'NativeSessionProbe.cs'),
        (Join-Path $PSScriptRoot 'PreparedCylinder.cs'), (Join-Path $PSScriptRoot 'InterruptionCase.ps1'),
        (Join-Path $PSScriptRoot '../file-admission/SharedFilePredicates.cs'),
        (Join-Path $PSScriptRoot '../file-admission/OwnedProcess.ps1'))
    foreach ($source in $sources) {
        $name = [IO.Path]::GetFileName($source); $destination = Join-Path $folder $name
        $digest = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant()
        Copy-Item -LiteralPath $source -Destination $destination -ErrorAction Stop
        if ((Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant() -ne $digest) { throw 'Source copy digest mismatch.' }
        $r.sourceHashes += @{ name = $name; sha256 = $digest }
    }
    if ((Get-FileHash -LiteralPath (Join-Path $folder 'OwnedProcess.ps1') -Algorithm SHA256).Hash.ToLowerInvariant() -ne
        'd4d08e782b492cc167924d5a04f927970e191102828aae65b7da43393e6cf23e') { throw 'helper source drift' }
}
# Compile copied C# using the observed installed compiler, never a downloaded SDK.
function Build-LifecycleProbe {
    $compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
    $r.compiler = @{ path = $compiler; version = (Get-Item -LiteralPath $compiler).VersionInfo.FileVersion;
        sha256 = (Get-FileHash -LiteralPath $compiler -Algorithm SHA256).Hash.ToLowerInvariant() }
    if (-not $r.compiler.version.StartsWith('4.8.9221.0') -or
        $r.compiler.sha256 -ne '46809206887326d2d24db1eff1f3064de972c3451abe766b49111450a5e08e00') { throw 'Installed compiler pin mismatch.' }
    $arguments = @('/nologo', '/target:exe', '/platform:x64', '/optimize+', '/reference:System.dll',
        '/reference:System.Core.dll', '/reference:System.Web.Extensions.dll', ('/reference:' + $interop),
        ('/out:' + $helper), (Join-Path $folder 'NativeSessionProbe.cs'),
        (Join-Path $folder 'PreparedCylinder.cs'), (Join-Path $folder 'SharedFilePredicates.cs'))
    $r.stage = 'compile_probe'; Save-Receipt
    $r.compile = Invoke-OwnedProcess $compiler $arguments 30000 (Join-Path $folder 'compile')
    Save-Receipt
    if ($r.compile.error -or $r.compile.timedOut -or $r.compile.exitCode -ne 0) { throw 'Probe compilation failed; no native action taken.' }
    $r.binarySha256 = (Get-FileHash -LiteralPath $helper -Algorithm SHA256).Hash.ToLowerInvariant()
}
# Every API action independently rechecks the pinned singleton and requires zero documents.
function Invoke-LifecycleProbe($Mode, $Process, $Identity, $Label, [bool]$AllowNotReady = $false, [int]$TimeoutMs = 30000) {
    Assert-Identity $Process $Identity
    if ((Get-FileHash -LiteralPath $helper -Algorithm SHA256).Hash.ToLowerInvariant() -ne $r.binarySha256) { throw 'probe binary drift' }
    # Mark a close attempt before dispatch; failed or missing helper evidence cannot prove no native effect.
    if ($Mode -eq 'graceful-close-empty') { $r.nativeCloseAttempted = $true }
    $r.stage = $Label; Save-Receipt
    $obs = Invoke-OwnedProcess -Executable $helper -Arguments @($Mode, [string]$Identity.pid, $Identity.ticks, [string]$Identity.session) -TimeoutMs $TimeoutMs -LogBase (Join-Path $folder $Label)
    $r.observations += $obs; Save-Receipt
    if ($obs.timedOut -or $obs.error) { throw ('Probe failed: ' + $Label) }
    $data = $obs.stdout | ConvertFrom-Json
    if ($AllowNotReady -and $Mode -eq 'inspect' -and $obs.exitCode -eq 3 -and $data.outcome -eq 'not_ready' -and
        $data.expectedPid -eq $Identity.pid -and $data.expectedTicks -ceq $Identity.ticks -and $data.exitAppRequested -eq $false) { return $false }
    if ($obs.exitCode -ne 0) { throw ('Probe failed: ' + $Label) }
    $releaseError = $data.PSObject.Properties['releaseError']
    if ($data.outcome -ne 'passed' -or $data.apiPid -ne $Identity.pid -or $data.expectedTicks -cne $Identity.ticks -or
        $data.startupCompleted -ne $true -or $data.documentCount -ne 0 -or
        ($null -ne $releaseError -and $releaseError.Value)) { throw 'probe evidence mismatch' }
    return $true
}
function Close-OldSession {
    [void](Invoke-LifecycleProbe 'inspect' $old $r.old 'old-inspect')
    [void](Invoke-LifecycleProbe 'graceful-close-empty' $old $r.old 'old-close')
    $r.stage = 'wait_old_exit'; Save-Receipt
    if (-not $old.WaitForExit(30000)) { throw 'old exit unconfirmed; do not start' }
    $r.oldExit = $old.ExitCode; Save-Receipt
    if ($r.oldExit -ne 0) { throw 'old native nonzero exit' }
}
# Poll only specifically classified startup-not-ready observations on the retained
# process. Each probe timeout is capped by the remaining 60-second readiness budget;
# the shared helper's bounded capture/cleanup waits may add up to 15 seconds.
function Wait-NativeReady([string]$Label = 'owned-ready') {
    $timer = [Diagnostics.Stopwatch]::StartNew(); $attempt = 0
    while ($timer.ElapsedMilliseconds -lt 60000) {
        $attempt++; $remaining = 60000 - $timer.ElapsedMilliseconds
        $timeout = [int][Math]::Min(30000, $remaining)
        if (Invoke-LifecycleProbe 'inspect' $native $r.native ($Label + '-' + $attempt) $true $timeout) { return }
        $remaining = 60000 - $timer.ElapsedMilliseconds
        if ($remaining -gt 0) { Start-Sleep -Milliseconds ([int][Math]::Min(1000, $remaining)) }
    }
    throw 'native API readiness deadline exceeded'
}
# Normal ExitApp is the sole native close path; idle wait is not proof of COM readiness.
function Complete-NativeLifecycle {
    if (-not $native.WaitForInputIdle(60000)) { throw 'native readiness unconfirmed' }
    Wait-NativeReady
    Close-OwnedNative
}
function Close-OwnedNative([string]$Label = 'owned-close') {
    [void](Invoke-LifecycleProbe 'graceful-close-empty' $native $r.native $Label)
    $r.stage = 'wait_owned_exit'; Save-Receipt
    if (-not $native.WaitForExit(30000)) { throw 'owned native exit unconfirmed' }
    $r.nativeExit = $native.ExitCode
    if ($r.nativeExit -ne 0) { throw 'owned native nonzero exit' }
    Assert-NoNative 'unexpected final native process'
}
# The same directly started and retained object is used by the normal and interruption paths.
function Start-NativeProcess([string]$Label = 'start_native') {
    Assert-NoNative 'native process still present'
    Assert-NativeBinary
    $script:native = New-Object Diagnostics.Process
    $r.nativeStarted = $false; $r.nativeExit = $null
    $r.native = $null; $r.nativePid = $null
    $native.StartInfo.FileName = $exe; $native.StartInfo.WorkingDirectory = $folder
    $native.StartInfo.UseShellExecute = $false; $native.StartInfo.CreateNoWindow = $true
    $native.StartInfo.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
    $r.stage = $Label; $r.nativeStartAttempted = $true; Save-Receipt
    if (-not $native.Start()) { throw 'native start false' }
    $r.nativeStarted = $true; $r.nativePid = $native.Id; Save-Receipt
    $r.native = Read-Identity $native; Save-Receipt
}
# Observation or handle-release failure must never retain a passing outcome.
function Complete-LifecycleObservations {
    if ($native -and $r.nativeStarted) {
        try {
            $r.nativeHasExited = $native.HasExited
            if ($r.nativeHasExited) { $r.nativeExit = $native.ExitCode }
        } catch { $r.nativeObservationError = $_.Exception.Message; Add-Failure ('Final observation: ' + $_.Exception.Message) }
    }
    foreach ($process in @($old, $native)) {
        if ($null -eq $process) { continue }
        try { $process.Dispose() } catch { Add-Failure ('Handle disposal: ' + $_.Exception.Message) }
    }
}
try {
    Save-Receipt
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or -not [Environment]::Is64BitProcess -or
        $PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1) { throw 'Requires x64 Windows PowerShell 5.1.' }
    if ($SourceCommit) {
        if ($SourceCommit -cnotmatch '^[0-9a-f]{40}$') { throw 'SourceCommit must be a lowercase commit label.' }
        $r.sourceCommit = $SourceCommit
    }
    Assert-CallerBinding; Assert-NativeBinary
    if ((Get-FileHash -LiteralPath $interop -Algorithm SHA256).Hash.ToLowerInvariant() -ne '9284fcfb569b3e7e906e7c8d1f551e6d073f79500ba78e32c6464a53571813f0' -or
        [Reflection.AssemblyName]::GetAssemblyName($interop).Version.ToString() -ne '30.5.0.49') { throw 'interop drift' }
    if ($ExpectedOldPid -gt 0) {
        $old = [Diagnostics.Process]::GetProcessById($ExpectedOldPid); $r.old = Read-Identity $old
        if ($r.old.ticks -cne $ExpectedOldTicks) { throw 'old session changed' }
        Assert-Identity $old $r.old
    }
    Copy-LifecycleSources
    . (Join-Path $folder 'OwnedProcess.ps1')
    . (Join-Path $folder 'InterruptionCase.ps1')
    [Environment]::CurrentDirectory = $folder
    if ($InterruptReadonly) { Prepare-InterruptionInputs }
    Build-LifecycleProbe
    if ($InterruptReadonly) { Invoke-InterruptionCase }
    else {
        if ($null -ne $old) { Close-OldSession }
        Start-NativeProcess
        Complete-NativeLifecycle
    }
    $r.outcome = 'passed'
} catch { Add-Failure $_.Exception.Message }
finally {
    Complete-LifecycleObservations
    try { [Environment]::CurrentDirectory = $previousDirectory } catch { Add-Failure ('Working directory: ' + $_.Exception.Message) }
    try { Save-Receipt } catch {
        Add-Failure ('Receipt persistence: ' + $_.Exception.Message)
        Write-Output ($r | ConvertTo-Json -Depth 20)
    }
    Write-Output $resultPath
}
if ($r.outcome -ne 'passed') { exit 2 }
exit 0
