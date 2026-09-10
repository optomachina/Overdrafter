#requires -Version 5.1
<#
.SYNOPSIS
Runs one explicit synthetic prepared-dimension request in a directly owned native process.
.DESCRIPTION
Default-off. Never adopts an existing native process, activates COM to create one,
forces native termination, retries uncertain edits, or publishes/adopts outputs.
#>
[CmdletBinding()]
param(
    [switch]$Execute,
    [Parameter(Mandatory = $true)][string]$RequestPath,
    [Parameter(Mandatory = $true)][string]$ContextPath,
    [Parameter(Mandatory = $true)][string]$PackageRoot,
    [Parameter(Mandatory = $true)][string]$OutputRoot,
    [string]$SourceCommit,
    [string]$JournalBindingPath,
    [ValidateSet('native_launch_intent','native_identity','outputs_saved','native_exit','startup_deadline')][string]$QualificationPauseAt
)
if (-not $Execute) { throw 'Default-off: -Execute is required for one native candidate evaluation.' }
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'WireContract.ps1')
. (Join-Path $PSScriptRoot 'WireContractV2.ps1')
# An invalid job has no admitted identity and cannot produce an importable result.
$request = Read-PreparedJson $RequestPath
$job = $request.value
$isCumulative = Test-PreparedText $job.schema 'overdrafter.prepared-dimension-job.v2'
$expectedDepthMm = 5
if ($isCumulative) { Assert-CumulativeJob $job; $expectedDepthMm = $job.expectedDepthMm }
else { Assert-PreparedJob $job }
$journalBinding = $null
if ($JournalBindingPath) {
    if (-not $isCumulative) { throw 'An attempt journal requires the cumulative v2 job contract.' }
    . (Join-Path $PSScriptRoot '../attempt-journal/JournalRunner.ps1')
    $journalBinding = (Read-PreparedJson $JournalBindingPath).value
    Assert-JournalBinding $journalBinding
    if ($journalBinding.organizationId -cne $job.scope.organizationId -or $journalBinding.projectId -cne $job.scope.projectId -or
        $journalBinding.jobId -cne $job.jobId -or $journalBinding.attemptId -cne $job.attemptId -or
        $journalBinding.fence -ne $job.fence -or $journalBinding.jobSha256 -cne $request.sha256) { throw 'Journal binding differs from the exact cumulative job.' }
}
if ($QualificationPauseAt) {
    if ($null -eq $journalBinding) { throw 'Qualification pause requires an explicit v2 journal.' }
    . (Join-Path $PSScriptRoot '../attempt-journal/QualificationCheckpoint.ps1')
    Assert-PreparedQualificationScope $job $journalBinding $SourceCommit
}
$expectedFiles = $job.inputFiles
$output = Resolve-PreparedLocalPath $OutputRoot
$PackageRoot = Resolve-PreparedLocalPath $PackageRoot
$folder = Join-Path $output $job.attemptId
if ($folder.Length -gt 100) { throw 'Use a short output root; attempt path must not exceed 100 characters.' }
$sourcePrefix = $PackageRoot.TrimEnd('\') + '\'
$attemptPrefix = $folder.TrimEnd('\') + '\'
if ($folder.Equals($PackageRoot, [StringComparison]::OrdinalIgnoreCase) -or
    $folder.StartsWith($sourcePrefix, [StringComparison]::OrdinalIgnoreCase) -or
    $PackageRoot.StartsWith($attemptPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'The private attempt directory and original package must be disjoint.'
}
if (Test-Path -LiteralPath $folder) { throw 'Attempt directory already exists; this attempt must not be executed again.' }
New-Item -ItemType Directory -Path $folder -ErrorAction Stop | Out-Null
$candidate = Join-Path $folder 'candidate'
$result = [ordered]@{
    schema = 'overdrafter.prepared-dimension-result.v1'; jobId = $job.jobId; attemptId = $job.attemptId;
    requestSha256 = $request.sha256; contextSha256 = $job.contextSha256; depthMm = $job.depthMm;
    outcome = 'failed'; failureReason = 'Attempt did not complete.'; inputFiles = @(); outputFiles = @();
    checks = @(); measurements = $null; candidateRoot = $null; completedAt = $null; adoption = 'unadopted'
}
if ($isCumulative) {
    $result.schema = 'overdrafter.prepared-dimension-result.v2'
    foreach ($key in @('scope', 'fence', 'inputSnapshotId', 'outputSnapshotId')) { $result[$key] = $job.$key }
}
$supervisor = [ordered]@{
    schema = 'overdrafter.prepared-dimension-supervisor.v1'; jobId = $job.jobId; attemptId = $job.attemptId;
    requestSha256 = $request.sha256; stage = 'preflight'; sourceCommit = $null; sources = @();
    compiler = $null; binaries = @{}; observations = @(); sourceHistory = @();
    nativeStartAttempted = $false; nativeStarted = $false; nativeCloseAttempted = $false;
    native = $null; nativeExit = $null; recoveryRequired = $false; error = $null;
    limitations = @('Shared existing Windows profile; not a filesystem/network sandbox.',
        'One synthetic assembly; no customer/PDM/publishing or automatic native recovery.')
}
$native = $null; $mutex = $null; $lockHeld = $false
$journalSession = $null; $nativeLaunch = $null
$previousDirectory = [Environment]::CurrentDirectory
$exe = 'C:\Program Files\SOLIDWORKS 2022\SOLIDWORKS\SLDWORKS.exe'
$exeHash = '6384c0829bac149831be5fdc9e705c90612273d25b46fdff5e5760d11e22d6cc'
$interop = 'C:\Program Files\SOLIDWORKS 2022\SOLIDWORKS\api\redist\SolidWorks.Interop.sldworks.dll'
$lifecycleHelper = Join-Path $folder 'NativeSessionProbe.exe'
$operationHelper = Join-Path $folder 'PreparedDimensionProbe.exe'

function Save-PreparedProgress {
    $encoding = New-Object Text.UTF8Encoding($false, $true)
    [IO.File]::WriteAllText((Join-Path $folder 'progress.json'), ($supervisor | ConvertTo-Json -Depth 40), $encoding)
}
function Throw-PreparedFailure([string]$Code, [string]$Message) {
    $failure = New-Object InvalidOperationException($Message)
    $failure.Data['overdrafter.native.failureCode'] = $Code
    throw $failure
}
function Invoke-PreparedChild([string]$Role, [string]$Executable, [string[]]$Arguments, [int]$TimeoutMs, [string]$LogBase, $Journal = $null) {
    if ($null -ne $Journal) { return Invoke-RunnerJournalChild $Journal $Role $Executable $Arguments $TimeoutMs $LogBase }
    return Invoke-OwnedProcess $Executable $Arguments $TimeoutMs $LogBase
}
function Fail-PreparedAttempt([string]$Message) {
    $result.outcome = 'failed'
    $result.failureReason = $Message
    if ($supervisor.error) { $supervisor.error += ' ' + $Message } else { $supervisor.error = $Message }
    if ($supervisor.nativeStartAttempted -or $supervisor.nativeCloseAttempted) { $supervisor.recoveryRequired = $true }
}
function Assert-PreparedNativeAbsent {
    # Enumerate successfully, then filter: an enumeration error is not an empty inventory.
    $all = @(Get-Process -ErrorAction Stop)
    try { foreach ($process in $all) { if ($process.ProcessName -ieq 'SLDWORKS') { throw 'An existing native process prevents this job.' } } }
    finally { foreach ($process in $all) { $process.Dispose() } }
}
function Assert-PreparedRuntime {
    $version = [Diagnostics.FileVersionInfo]::GetVersionInfo($exe)
    if ($version.FileVersion -ne '30.5.0.0049' -or $version.ProductVersion -ne '30.5.0.0049' -or
        (Get-PreparedHash $exe) -cne $exeHash) { Throw-PreparedFailure 'runtime_mismatch' 'Native runtime identity differs.' }
    if ((Get-PreparedHash $interop) -cne '9284fcfb569b3e7e906e7c8d1f551e6d073f79500ba78e32c6464a53571813f0' -or
        [Reflection.AssemblyName]::GetAssemblyName($interop).Version.ToString() -ne '30.5.0.49') { Throw-PreparedFailure 'runtime_mismatch' 'Interop identity differs.' }
}
function Assert-PreparedNativeIdentity {
    if ($null -eq $native -or -not $supervisor.nativeStarted -or $native.HasExited) { throw 'Owned native process is unavailable.' }
    $null = $native.Handle
    $all = @(Get-Process SLDWORKS -ErrorAction Stop)
    try {
        if ($all.Count -ne 1 -or $all[0].Id -ne $native.Id -or $native.Id -ne $supervisor.native.pid -or
            $native.StartTime.ToUniversalTime().Ticks.ToString() -cne $supervisor.native.ticks -or
            $native.SessionId -ne $supervisor.native.session -or
            $native.SessionId -ne [Diagnostics.Process]::GetCurrentProcess().SessionId -or
            $native.MainModule.FileName -ine $exe) { throw 'Owned native identity drift.' }
    } finally { foreach ($process in $all) { $process.Dispose() } }
    Assert-PreparedRuntime
}
# Preserve each actual observation before testing its expected value. Missing/unread
# files never acquire an invented identity in an importable failure result.
function Read-PreparedOriginals([string]$Phase) {
    $result.inputFiles = @()
    $history = [ordered]@{ phase = $Phase; files = @(); error = $null }
    $supervisor.sourceHistory += $history
    try {
        foreach ($expected in $expectedFiles) {
            $path = Join-Path $PackageRoot $expected.path
            $file = Get-Item -LiteralPath $path -ErrorAction Stop
            if ($file.PSIsContainer -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Expected a regular original file.' }
            $record = [ordered]@{ path = $expected.path; bytes = $file.Length; sha256 = (Get-PreparedHash $path) }
            $history.files += $record; $result.inputFiles += $record
            if ($record.bytes -ne $expected.bytes -or $record.sha256 -cne $expected.sha256) {
                throw ('Original input differs: ' + $expected.path)
            }
        }
    } catch { $history.error = $_.Exception.Message; throw }
}
function Copy-PreparedSources {
    $paths = @('run.ps1', 'WireContract.ps1', 'WireContractV2.ps1', 'capture-context.ps1', 'PreparedDimensionProbe.cs', 'PreparedPackage.cs', 'PartGeometry.cs')
    $sources = @(); foreach ($path in $paths) { $sources += Join-Path $PSScriptRoot $path }
    $sources += Join-Path $PSScriptRoot '../session-lifecycle/NativeSessionProbe.cs'
    $sources += Join-Path $PSScriptRoot '../session-lifecycle/PreparedCylinder.cs'
    $sources += Join-Path $PSScriptRoot '../session-lifecycle/AssemblyRecovery.cs'
    $sources += Join-Path $PSScriptRoot '../file-admission/SharedFilePredicates.cs'
    $sources += Join-Path $PSScriptRoot '../file-admission/OwnedProcess.ps1'
    if ($null -ne $journalBinding) {
        foreach ($name in @('JournalContract.ps1', 'JournalStore.ps1', 'JournalRunner.ps1', 'ProcessIdentity.ps1')) { $sources += Join-Path $PSScriptRoot ('../attempt-journal/' + $name) }
        foreach ($name in @('CompanionState.ps1', 'CompanionStore.ps1')) { $sources += Join-Path $PSScriptRoot ('../worker-companion/' + $name) }
    }
    if ($QualificationPauseAt) { $sources += Join-Path $PSScriptRoot '../attempt-journal/QualificationCheckpoint.ps1' }
    foreach ($source in $sources) {
        $name = [IO.Path]::GetFileName($source); $destination = Join-Path $folder $name
        $digest = Get-PreparedHash $source
        [IO.File]::Copy($source, $destination, $false)
        if ((Get-PreparedHash $destination) -cne $digest) { throw 'Copied source identity drift.' }
        $supervisor.sources += @{ name = $name; sha256 = $digest }
    }
    if ((Get-PreparedHash (Join-Path $folder 'OwnedProcess.ps1')) -cne
        'd4d08e782b492cc167924d5a04f927970e191102828aae65b7da43393e6cf23e') { throw 'Owned-process helper differs.' }
}
function Build-PreparedHelpers {
    $compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
    $supervisor.compiler = @{ path = $compiler; version = (Get-Item -LiteralPath $compiler).VersionInfo.FileVersion; sha256 = (Get-PreparedHash $compiler) }
    if (-not $supervisor.compiler.version.StartsWith('4.8.9221.0') -or $supervisor.compiler.sha256 -cne
        '46809206887326d2d24db1eff1f3064de972c3451abe766b49111450a5e08e00') { throw 'Compiler identity differs.' }
    $common = @('/nologo', '/target:exe', '/platform:x64', '/optimize+', '/reference:System.dll',
        '/reference:System.Core.dll', '/reference:System.Web.Extensions.dll', ('/reference:' + $interop))
    foreach ($name in @('NativeSessionProbe', 'PreparedDimensionProbe')) {
        $sourceNames = @('NativeSessionProbe.cs', 'PreparedCylinder.cs', 'SharedFilePredicates.cs',
            'AssemblyRecovery.cs', 'PreparedDimensionProbe.cs', 'PreparedPackage.cs', 'PartGeometry.cs')
        if ($name -eq 'PreparedDimensionProbe') { $sourceNames = @('PreparedDimensionProbe.cs', 'PreparedPackage.cs', 'PartGeometry.cs') }
        $arguments = $common + @(('/main:' + $name), ('/out:' + (Join-Path $folder ($name + '.exe'))))
        foreach ($sourceName in $sourceNames) { $arguments += Join-Path $folder $sourceName }
        $supervisor.stage = 'compile_' + $name; Save-PreparedProgress
        $observation = Invoke-PreparedChild 'compiler' $compiler $arguments 30000 (Join-Path $folder ('compile-' + $name)) -Journal $journalSession
        $supervisor.observations += @{ stage = $supervisor.stage; result = $observation }; Save-PreparedProgress
        if ($observation.error -or $observation.timedOut -or $observation.exitCode -ne 0) { throw ('Compilation failed: ' + $name) }
        $supervisor.binaries[$name] = Get-PreparedHash (Join-Path $folder ($name + '.exe'))
    }
}
function Invoke-PreparedLifecycle([string]$Mode, [string]$Label, [int]$TimeoutMs = 30000, [switch]$AllowNotReady, $Journal = $null) {
    Assert-PreparedNativeIdentity
    if ((Get-PreparedHash $lifecycleHelper) -cne $supervisor.binaries.NativeSessionProbe) { throw 'Lifecycle probe binary drift.' }
    if ($Mode -eq 'graceful-close-empty') { $supervisor.nativeCloseAttempted = $true }
    $supervisor.stage = $Label; Save-PreparedProgress
    $arguments = @($Mode, [string]$supervisor.native.pid, $supervisor.native.ticks, [string]$supervisor.native.session)
    $observation = Invoke-PreparedChild 'lifecycle' $lifecycleHelper $arguments $TimeoutMs (Join-Path $folder $Label) -Journal $Journal
    $supervisor.observations += @{ stage = $Label; result = $observation }; Save-PreparedProgress
    if ($observation.error -or $observation.timedOut) { throw ('Lifecycle helper failed: ' + $Label) }
    $data = $observation.stdout | ConvertFrom-Json
    if ($AllowNotReady -and $Mode -eq 'inspect' -and $observation.exitCode -eq 3 -and $data.outcome -ceq 'not_ready' -and
        $data.expectedPid -eq $supervisor.native.pid -and $data.expectedTicks -ceq $supervisor.native.ticks -and $data.exitAppRequested -eq $false) { return $false }
    if ($observation.exitCode -ne 0) { throw ('Lifecycle probe rejected: ' + $Label) }
    $release = $data.PSObject.Properties['releaseError']
    if ($data.outcome -cne 'passed' -or $data.apiPid -ne $supervisor.native.pid -or
        $data.expectedTicks -cne $supervisor.native.ticks -or $data.startupCompleted -ne $true -or
        $data.documentCount -ne 0 -or ($null -ne $release -and $release.Value)) { throw 'Lifecycle evidence mismatch.' }
    return $true
}
# Monotonic elapsed time is separate from wall-clock timestamps. The pure test
# lane substitutes this clock, never the readiness coordinator under test.
function New-PreparedStartupClock { return [Diagnostics.Stopwatch]::StartNew() }
function Wait-PreparedNativeReady($Journal = $null,[switch]$QualificationDelayedReadiness) {
    $startup=[ordered]@{schema='overdrafter.native-startup-observation.v1';guiTimeoutMs=60000;apiTimeoutMs=60000;
        guiElapsedMs=0;apiElapsedMs=0;guiReady=$null;probes=@();outcome='checking';failureCode=$null;
        qualificationDelayedReadiness=[bool]$QualificationDelayedReadiness}
    $supervisor['startup']=$startup
    $guiClock=$null; $apiClock=$null
    try {
        $guiClock=New-PreparedStartupClock
        try { $startup.guiReady=$native.WaitForInputIdle(60000) }
        finally { $startup.guiElapsedMs=$guiClock.ElapsedMilliseconds; $guiClock.Stop() }
        if (-not $startup.guiReady -or $startup.guiElapsedMs -ge 60000) {
            Throw-PreparedFailure 'native_startup_timeout' 'Native GUI readiness deadline exceeded.'
        }
        $apiClock=New-PreparedStartupClock; $number=0
        while ($apiClock.ElapsedMilliseconds -lt 60000) {
            $remaining=60000-$apiClock.ElapsedMilliseconds
            if ($remaining -le 0) { break }
            $number++
            $probe=[ordered]@{number=$number;timeoutMs=([int][Math]::Min(30000,$remaining));
                startedMs=$apiClock.ElapsedMilliseconds;returnedMs=$null;finishedMs=$null;injectedDelayMs=0;outcome='running'}
            $startup.probes+=@($probe)
            try {
                $ready=Invoke-PreparedLifecycle 'inspect' ('ready-'+$number) $probe.timeoutMs -AllowNotReady -Journal $Journal
                $probe.returnedMs=$apiClock.ElapsedMilliseconds
                $probe.outcome='not_ready'; if ($ready) { $probe.outcome='ready' }
                if ($QualificationDelayedReadiness -and $ready) {
                    # Explicit original-job qualification only. Preserve the
                    # genuine probe return, then delay its admission observation.
                    $probe.injectedDelayMs=60000
                    Start-Sleep -Milliseconds 60000
                }
            } catch { $probe.outcome='error'; throw }
            finally { $probe.finishedMs=$apiClock.ElapsedMilliseconds }
            # Successful helper output is not timely readiness if it arrived
            # after the deadline. Check before any operation can be admitted.
            if ($probe.finishedMs -ge 60000) { break }
            if ($ready) { $startup.outcome='ready'; return }
            $remaining=60000-$apiClock.ElapsedMilliseconds
            if ($remaining -gt 0) { Start-Sleep -Milliseconds ([int][Math]::Min(1000,$remaining)) }
        }
        Throw-PreparedFailure 'native_startup_timeout' 'Native API readiness deadline exceeded.'
    } catch {
        $startup.outcome='failed'; $startup.failureCode='unclassified'
        if ($_.Exception.Data.Contains('overdrafter.native.failureCode')) { $startup.failureCode=$_.Exception.Data['overdrafter.native.failureCode'] }
        throw
    } finally {
        if ($null -ne $apiClock) { $startup.apiElapsedMs=$apiClock.ElapsedMilliseconds; $apiClock.Stop() }
    }
}
# Validates the already-bound native report without performing native actions.
function Assert-PreparedMeasurements($data, $job) {
    $beforeDepth = 5
    if (Test-PreparedText $job.schema 'overdrafter.prepared-dimension-job.v2') { $beforeDepth = $job.expectedDepthMm }
    foreach ($name in @('beforeDepthMm', 'afterDepthMm', 'beforeVolumeMm3', 'afterVolumeMm3')) {
        if (-not (Test-PreparedNumber $data.measurements.$name)) { throw 'Native measurement is not finite.' }
    }
    if ([Math]::Abs($data.measurements.beforeDepthMm - $beforeDepth) -gt 1e-7 -or
        [Math]::Abs($data.measurements.afterDepthMm - $job.depthMm) -gt 1e-7 -or
        [Math]::Abs($data.measurements.beforeVolumeMm3 - ([Math]::PI * 100 * $beforeDepth)) -gt 0.1 -or
        [Math]::Abs($data.measurements.afterVolumeMm3 - ([Math]::PI * 100 * $job.depthMm)) -gt 0.1) { throw 'Native cylinder measurement mismatch.' }
}
function Invoke-PreparedOperation {
    Assert-PreparedNativeIdentity
    if ((Get-PreparedHash $operationHelper) -cne $supervisor.binaries.PreparedDimensionProbe) { throw 'Operation probe binary drift.' }
    $supervisor.stage = 'native_dimension'; Save-PreparedProgress
    $arguments = @([string]$supervisor.native.pid, $supervisor.native.ticks, [string]$supervisor.native.session, (Join-Path $folder 'settings.json'))
    $observation = Invoke-PreparedChild 'operation' $operationHelper $arguments 180000 (Join-Path $folder 'native-dimension') -Journal $journalSession
    $supervisor.observations += @{ stage = 'native_dimension'; result = $observation }; Save-PreparedProgress
    if ($observation.error -or $observation.timedOut -or $observation.exitCode -ne 0) { Throw-PreparedFailure 'native_operation_failed' 'Native dimension evaluation failed; reconcile retained native process.' }
    $data = $observation.stdout | ConvertFrom-Json
    if ($data.outcome -cne 'passed' -or $data.jobId -cne $job.jobId -or $data.attemptId -cne $job.attemptId -or
        $data.requestSha256 -cne $request.sha256 -or $data.contextSha256 -cne $job.contextSha256 -or
        $data.depthMm -ne $job.depthMm -or $data.expectedDepthMm -ne $expectedDepthMm -or $data.nativePid -ne $supervisor.native.pid -or
        $data.nativeStartTicks -cne $supervisor.native.ticks -or $data.candidateRoot -ine $candidate -or
        $data.releaseErrors.Count -ne 0 -or $data.verifiedChecks.Count -ne 5) { throw 'Native result binding mismatch.' }
    for ($i = 0; $i -lt 5; $i++) { if ($data.verifiedChecks[$i] -cne $PreparedChecks[$i + 1]) { throw 'Native verification set mismatch.' } }
    foreach ($check in $data.checks.PSObject.Properties) { if ($check.Value -isnot [bool] -or -not $check.Value) { throw 'Native predicate did not pass.' } }
    Assert-PreparedMeasurements $data $job
    return $data
}

try {
    Save-PreparedProgress
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or -not [Environment]::Is64BitProcess -or
        $PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1) { throw 'Requires x64 Windows PowerShell 5.1.' }
    if ($SourceCommit) {
        if ($SourceCommit -cnotmatch '^[0-9a-f]{40}$') { throw 'SourceCommit is an optional lowercase commit label.' }
        $supervisor.sourceCommit = $SourceCommit
    }
    [void](Write-PreparedBytes (Join-Path $folder 'request.json') $request.bytes)
    $context = Read-PreparedJson $ContextPath
    [void](Write-PreparedBytes (Join-Path $folder 'context.json') $context.bytes)
    if ($isCumulative) { Assert-CumulativeBinding $job $context.value $context.sha256 }
    else { Assert-PreparedContext $context.value }
    if ($context.sha256 -cne $job.contextSha256) { throw 'Exact context bytes do not match the request.' }
    Read-PreparedOriginals 'before'
    $inputHash = Write-PreparedJson (Join-Path $folder 'input-identity.json') (@{ requestSha256 = $request.sha256;
        contextSha256 = $context.sha256; packageRoot = $PackageRoot; files = $result.inputFiles })
    New-Item -ItemType Directory -Path (Join-Path $candidate 'parts') -ErrorAction Stop | Out-Null
    $result.candidateRoot = $candidate
    foreach ($file in $PreparedFiles) { [IO.File]::Copy((Join-Path $PackageRoot $file.path), (Join-Path $candidate $file.path), $false) }
    $copiedFiles = Measure-PreparedPackage $candidate
    Assert-CumulativeSameFiles $copiedFiles $expectedFiles
    Copy-PreparedSources
    . (Join-Path $folder 'OwnedProcess.ps1')
    [Environment]::CurrentDirectory = $folder
    if ($null -ne $journalBinding) { $journalSession = New-RunnerJournal $journalBinding }
    Assert-PreparedRuntime; Assert-PreparedNativeAbsent; Build-PreparedHelpers
    [void](Write-PreparedJson (Join-Path $folder 'settings.json') (@{ candidateRoot = $candidate; jobId = $job.jobId;
        attemptId = $job.attemptId; requestSha256 = $request.sha256; contextSha256 = $context.sha256;
        depthMm = $job.depthMm; expectedDepthMm = $expectedDepthMm; inputFiles = $expectedFiles }))
    $mutex = New-Object Threading.Mutex($false, 'Local\OverDrafterPreparedDimensionNative')
    try { $lockHeld = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $lockHeld = $true; throw 'Prior operator mutex was abandoned; reconcile before another native attempt.' }
    if (-not $lockHeld) { throw 'Another prepared native operation is active.' }
    Assert-PreparedNativeAbsent; Assert-PreparedRuntime
    $native = New-Object Diagnostics.Process
    $native.StartInfo.FileName = $exe; $native.StartInfo.WorkingDirectory = $folder
    $native.StartInfo.UseShellExecute = $false; $native.StartInfo.CreateNoWindow = $true
    $native.StartInfo.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
    $supervisor.stage = 'start_native'; $supervisor.nativeStartAttempted = $true; Save-PreparedProgress
    if ($null -ne $journalSession) { $nativeLaunch = New-RunnerJournalLaunch $journalSession 'native' $exe @() $folder }
    if ($QualificationPauseAt) { Wait-PreparedQualificationCheckpoint $QualificationPauseAt 'native_launch_intent' $folder $journalSession }
    if (-not $native.Start()) { throw 'Native process start returned false.' }
    $supervisor.nativeStarted = $true
    $supervisor.nativePid = $native.Id
    $null = $native.Handle
    $supervisor.native = @{ pid = $native.Id; ticks = $native.StartTime.ToUniversalTime().Ticks.ToString();
        session = $native.SessionId; path = $native.MainModule.FileName }
    if ($null -ne $journalSession) {
        Set-RunnerJournalCreation $journalSession $nativeLaunch $native
        Add-RunnerJournalEvent $journalSession phase ([pscustomobject]@{phase='startup_wait'})
    }
    if ($QualificationPauseAt) { Wait-PreparedQualificationCheckpoint $QualificationPauseAt 'native_identity' $folder $journalSession }
    Save-PreparedProgress
    Wait-PreparedNativeReady -Journal $journalSession -QualificationDelayedReadiness:($QualificationPauseAt -ceq 'startup_deadline')
    if ($null -ne $journalSession) {
        Add-RunnerJournalEvent $journalSession phase ([pscustomobject]@{phase='startup_ready'})
        Add-RunnerJournalEvent $journalSession phase ([pscustomobject]@{phase='operation_started'})
    }
    $nativeData = Invoke-PreparedOperation
    if ($null -ne $journalSession) {
        Add-RunnerJournalEvent $journalSession phase ([pscustomobject]@{phase='operation_completed'})
        Add-RunnerJournalEvent $journalSession phase ([pscustomobject]@{phase='outputs_saved'})
    }
    if ($QualificationPauseAt) { Wait-PreparedQualificationCheckpoint $QualificationPauseAt 'outputs_saved' $folder $journalSession }
    [void](Invoke-PreparedLifecycle 'graceful-close-empty' 'close-native' -Journal $journalSession)
    if (-not $native.WaitForExit(30000)) { throw 'Native exit is unconfirmed.' }
    $supervisor.nativeExit = $native.ExitCode
    if ($null -ne $journalSession) { Set-RunnerJournalExit $journalSession $nativeLaunch $native.ExitCode $false }
    if ($supervisor.nativeExit -ne 0) { throw 'Native exit was nonzero.' }
    if ($QualificationPauseAt) { Wait-PreparedQualificationCheckpoint $QualificationPauseAt 'native_exit' $folder $journalSession }
    Assert-PreparedNativeAbsent
    Read-PreparedOriginals 'after'
    $sourceHash = Write-PreparedJson (Join-Path $folder 'source-preservation.json') $supervisor.sourceHistory
    $outputs = Measure-PreparedPackage $candidate
    if (($job.depthMm -ne $expectedDepthMm -and $outputs[1].sha256 -ceq $expectedFiles[1].sha256) -or
        $outputs[2].sha256 -cne $expectedFiles[2].sha256 -or $outputs[2].bytes -ne $expectedFiles[2].bytes) {
        throw 'Changed target / unchanged companion output identity check failed.'
    }
    $nativeHash = Get-PreparedHash (Join-Path $folder 'native-dimension.stdout.txt')
    foreach ($check in $PreparedChecks) {
        $evidenceHash = $nativeHash
        if ($check -eq 'input_identity') { $evidenceHash = $inputHash }
        elseif ($check -eq 'source_preservation') { $evidenceHash = $sourceHash }
        $result.checks += @{ id = $check; verdict = 'pass'; evidenceSha256 = $evidenceHash }
    }
    $result.outputFiles = $outputs; $result.measurements = $nativeData.measurements
    $result.outcome = 'succeeded'; $result.failureReason = $null; $supervisor.stage = 'completed'
} catch {
    $failure = $_.Exception
    if ($failure.Data.Contains('overdrafter.native.childObservation')) {
        $supervisor.observations += @{ stage = $supervisor.stage; result = $failure.Data['overdrafter.native.childObservation'] }
    }
    Fail-PreparedAttempt $failure.Message
    if ($null -ne $journalSession) {
        try {
            $code = 'unclassified'
            if ($failure.Data.Contains('overdrafter.native.failureCode')) { $code = $failure.Data['overdrafter.native.failureCode'] }
            $supervisor.failureCode = $code
            Add-RunnerJournalEvent $journalSession failure ([pscustomobject]@{code=$code;evidenceSha256=(Get-JournalDigest $failure.Message)})
            if ($QualificationPauseAt -ceq 'startup_deadline' -and $code -ceq 'native_startup_timeout') {
                Save-PreparedProgress
                Wait-PreparedQualificationCheckpoint $QualificationPauseAt 'startup_deadline' $folder $journalSession
            }
        } catch { Fail-PreparedAttempt ('Journal failure observation: ' + $_.Exception.Message) }
    }
}
finally {
    if ($native) {
        try {
            if ($supervisor.nativeStarted) {
                $supervisor.nativeHasExited = $native.HasExited
                if ($native.HasExited) {
                    $supervisor.nativeExit = $native.ExitCode
                    if ($null -ne $journalSession -and $null -ne $nativeLaunch -and $null -ne $nativeLaunch.identity) {
                        Set-RunnerJournalExit $journalSession $nativeLaunch $native.ExitCode $false
                    }
                }
            }
        } catch { Fail-PreparedAttempt ('Final native observation: ' + $_.Exception.Message) }
        finally {
            try { $native.Dispose() }
            catch { Fail-PreparedAttempt ('Final native disposal: ' + $_.Exception.Message) }
        }
    }
    try { [Environment]::CurrentDirectory = $previousDirectory } catch { Fail-PreparedAttempt ('Working directory: ' + $_.Exception.Message) }
    if ($mutex) {
        try { if ($lockHeld) { $mutex.ReleaseMutex() }; $mutex.Dispose() }
        catch { Fail-PreparedAttempt ('Operator mutex: ' + $_.Exception.Message) }
    }
    if ($null -ne $journalSession) {
        try {
            $journalText = ConvertTo-JournalJson $journalSession.journal
            $journalHash = Write-PreparedBytes (Join-Path $folder 'attempt-journal.json') ([Text.Encoding]::UTF8.GetBytes($journalText))
            $summary = Get-NativeJournalSummary $journalSession.journal
            $supervisor.journal = @{ sha256=$journalHash; headSha256=$summary.headSha256; records=$summary.records;
                recordedProcessesExited=$summary.recordedProcessesExited; recoveryRequired=$summary.recoveryRequired }
            if ($summary.recoveryRequired -or $journalSession.store.poisoned) { Fail-PreparedAttempt 'Attempt journal requires recovery.' }
        } catch { Fail-PreparedAttempt ('Final journal receipt: ' + $_.Exception.Message) }
        finally { $journalSession.store.lock.Dispose() }
    }
    $result.completedAt = [DateTime]::UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'")
    if ($result.outcome -ne 'succeeded') { $result.outputFiles = @(); $result.measurements = $null }
    try { [void](Write-PreparedJson (Join-Path $folder 'supervisor-final.json') $supervisor) }
    catch { Fail-PreparedAttempt ('Final supervisor receipt: ' + $_.Exception.Message) }
    try { [void](Write-PreparedJson (Join-Path $folder 'result.json') $result) }
    catch { Write-Output ($result | ConvertTo-Json -Depth 40); throw }
    Write-Output (Join-Path $folder 'result.json')
}
if ($result.outcome -ne 'succeeded') { exit 2 }
exit 0
