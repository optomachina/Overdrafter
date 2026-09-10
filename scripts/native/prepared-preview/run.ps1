#requires -Version 5.1
<#
.SYNOPSIS
Exports one exact synthetic assembly to a bounded STEP preview bundle.
.DESCRIPTION
Default-off. Uses a newly started, retained native process and private read-only
copies. No native adoption, forced cleanup, preference changes, or blind retry.
#>
[CmdletBinding()]
param(
    [switch]$Execute,
    [Parameter(Mandatory = $true)][string]$Role,
    [Parameter(Mandatory = $true)][string]$ContextPath,
    [Parameter(Mandatory = $true)][string]$SourceRoot,
    [Parameter(Mandatory = $true)][string]$OutputRoot,
    [string]$RequestPath,
    [string]$ResultPath,
    [string]$SourceCommit
)
if (-not $Execute) { throw 'Default-off: -Execute is required for one native STEP preview.' }
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../prepared-dimension/WireContract.ps1')
. (Join-Path $PSScriptRoot '../prepared-dimension/WireContractV2.ps1')
. (Join-Path $PSScriptRoot 'PreviewContract.ps1')
$sharedDriver = Join-Path $PSScriptRoot '../prepared-dimension/run.ps1'
$sharedDriverHash = Get-PreparedHash $sharedDriver
. (Get-PreviewRuntimeFunctions $sharedDriver)
$SourceRoot = Resolve-PreparedLocalPath $SourceRoot
$output = Resolve-PreparedLocalPath $OutputRoot
$binding = Read-PreviewBinding $Role $ContextPath $RequestPath $ResultPath $SourceRoot
$folder = Join-Path $output ('preview-' + [Guid]::NewGuid().ToString('N'))
if ($folder.Length -gt 100) { throw 'Use a short output root; attempt path must not exceed 100 characters.' }
if ($folder.Equals($SourceRoot, [StringComparison]::OrdinalIgnoreCase) -or
    $folder.StartsWith($SourceRoot.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase) -or
    $SourceRoot.StartsWith($folder.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Private output and source package must be disjoint before any writes.'
}
if (Test-Path -LiteralPath $folder) { throw 'Preview attempt already exists.' }
if ($SourceCommit -and $SourceCommit -cnotmatch '^[0-9a-f]{40}$') { throw 'SourceCommit must be an optional lowercase commit label.' }
New-Item -ItemType Directory -Path $folder -ErrorAction Stop | Out-Null
$candidate = Join-Path $folder 'package'
$stepPath = Join-Path $folder 'step/assembly.step'
$commitLabel = $null; if ($SourceCommit) { $commitLabel = $SourceCommit }
# This private diagnostic object supports the unchanged shared failure helper. It is
# deliberately not a dimension result or an importable preview bundle.
$result = [ordered]@{ outcome = 'failed'; failureReason = 'Preview did not complete.' }
$supervisor = [ordered]@{
    schema = 'overdrafter.prepared-step-preview-supervisor.v1'; role = $Role; contextSha256 = $binding.context.sha256;
    requestSha256 = $binding.requestSha256; resultSha256 = $binding.resultSha256; sourceCommit = $commitLabel;
    stage = 'preflight'; sources = @(); compiler = $null; binaries = @{}; observations = @(); sourceHistory = @();
    nativeStartAttempted = $false; nativeStarted = $false; nativeCloseAttempted = $false; nativePid = $null;
    native = $null; nativeExit = $null; recoveryRequired = $false; error = $null
}
$native = $null; $mutex = $null; $lockHeld = $false; $nativeData = $null
$previousDirectory = [Environment]::CurrentDirectory
$exe = 'C:\Program Files\SOLIDWORKS 2022\SOLIDWORKS\SLDWORKS.exe'
$exeHash = '6384c0829bac149831be5fdc9e705c90612273d25b46fdff5e5760d11e22d6cc'
$interop = 'C:\Program Files\SOLIDWORKS 2022\SOLIDWORKS\api\redist\SolidWorks.Interop.sldworks.dll'
$swconst = 'C:\Program Files\SOLIDWORKS 2022\SOLIDWORKS\api\redist\SolidWorks.Interop.swconst.dll'
$swconstHash = 'b6f1aff6729712027d8c96b0da67ae3e949c133893c13c9a6add0ea5d27e35f1'
$lifecycleHelper = Join-Path $folder 'NativeSessionProbe.exe'
$operationHelper = Join-Path $folder 'StepPreviewProbe.exe'

function Confirm-PreviewInputs([string]$Phase) {
    $history = [ordered]@{ phase = $Phase; files = @(); error = $null }
    $supervisor.sourceHistory += $history
    try {
        $history.files = Measure-PreparedPackage $SourceRoot
        Assert-PreviewIdentities $history.files $binding.nativeFiles
        if ((Get-PreparedHash $ContextPath) -cne $binding.context.sha256) { throw 'Context bytes changed.' }
        if ($binding.request) {
            if ((Get-PreparedHash $RequestPath) -cne $binding.requestSha256 -or
                (Get-PreparedHash $ResultPath) -cne $binding.resultSha256) { throw 'Request or result bytes changed.' }
        }
    } catch { $history.error = $_.Exception.Message; throw }
}

function Copy-PreviewSources {
    $sources = @(
        @('run.ps1', 'run.ps1'), @('PreviewContract.ps1', 'PreviewContract.ps1'), @('StepPreviewProbe.cs', 'StepPreviewProbe.cs'),
        @('../prepared-dimension/run.ps1', 'dimension-run.ps1'), @('../prepared-dimension/WireContract.ps1', 'WireContract.ps1'),
        @('../prepared-dimension/WireContractV2.ps1', 'WireContractV2.ps1'),
        @('../prepared-dimension/PreparedDimensionProbe.cs', 'PreparedDimensionProbe.cs'),
        @('../prepared-dimension/PreparedPackage.cs', 'PreparedPackage.cs'), @('../prepared-dimension/PartGeometry.cs', 'PartGeometry.cs'),
        @('../session-lifecycle/NativeSessionProbe.cs', 'NativeSessionProbe.cs'), @('../session-lifecycle/PreparedCylinder.cs', 'PreparedCylinder.cs'),
        @('../session-lifecycle/AssemblyRecovery.cs', 'AssemblyRecovery.cs'),
        @('../file-admission/SharedFilePredicates.cs', 'SharedFilePredicates.cs'), @('../file-admission/OwnedProcess.ps1', 'OwnedProcess.ps1'))
    foreach ($source in $sources) {
        $path = Join-Path $PSScriptRoot $source[0]; $destination = Join-Path $folder $source[1]
        $hash = Get-PreparedHash $path; [IO.File]::Copy($path, $destination, $false)
        if ((Get-PreparedHash $destination) -cne $hash) { throw 'Copied source identity drift.' }
        $supervisor.sources += @{ name = $source[1]; sha256 = $hash }
    }
    if ((Get-PreparedHash (Join-Path $folder 'dimension-run.ps1')) -cne $sharedDriverHash -or
        (Get-PreparedHash (Join-Path $folder 'OwnedProcess.ps1')) -cne
        'd4d08e782b492cc167924d5a04f927970e191102828aae65b7da43393e6cf23e') { throw 'Shared driver or owned-process helper differs.' }
}

function Build-PreviewHelpers {
    $compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
    $supervisor.compiler = @{ path = $compiler; version = (Get-Item -LiteralPath $compiler).VersionInfo.FileVersion; sha256 = (Get-PreparedHash $compiler) }
    if (-not $supervisor.compiler.version.StartsWith('4.8.9221.0') -or $supervisor.compiler.sha256 -cne
        '46809206887326d2d24db1eff1f3064de972c3451abe766b49111450a5e08e00') { throw 'Compiler identity differs.' }
    $common = @('/nologo', '/target:exe', '/platform:x64', '/optimize+', '/reference:System.dll',
        '/reference:System.Core.dll', '/reference:System.Web.Extensions.dll', ('/reference:' + $interop))
    foreach ($name in @('NativeSessionProbe', 'StepPreviewProbe')) {
        $main = 'NativeSessionProbe'; $files = @('NativeSessionProbe.cs', 'PreparedCylinder.cs', 'SharedFilePredicates.cs',
            'AssemblyRecovery.cs', 'PreparedDimensionProbe.cs', 'PreparedPackage.cs', 'PartGeometry.cs')
        if ($name -ceq 'StepPreviewProbe') {
            $main = 'StepPreviewBootstrap'; $files = @('StepPreviewProbe.cs', 'PreparedDimensionProbe.cs', 'PreparedPackage.cs', 'PartGeometry.cs')
        }
        $arguments = $common + @(('/main:' + $main), ('/out:' + (Join-Path $folder ($name + '.exe'))))
        foreach ($file in $files) { $arguments += Join-Path $folder $file }
        $supervisor.stage = 'compile_' + $name; Save-PreparedProgress
        $observation = Invoke-OwnedProcess $compiler $arguments 30000 (Join-Path $folder ('compile-' + $name))
        $supervisor.observations += @{ stage = $supervisor.stage; result = $observation }; Save-PreparedProgress
        if ($observation.error -or $observation.timedOut -or $observation.exitCode -ne 0) { throw ('Compilation failed: ' + $name) }
        $supervisor.binaries[$name] = Get-PreparedHash (Join-Path $folder ($name + '.exe'))
    }
}

function Invoke-PreviewExport {
    Assert-PreparedNativeIdentity
    if ((Get-PreparedHash $operationHelper) -cne $supervisor.binaries.StepPreviewProbe) { throw 'Export binary drift.' }
    $supervisor.stage = 'native_step_export'; Save-PreparedProgress
    $arguments = @([string]$supervisor.native.pid, $supervisor.native.ticks, [string]$supervisor.native.session, (Join-Path $folder 'settings.json'))
    $observation = Invoke-OwnedProcess $operationHelper $arguments 180000 (Join-Path $folder 'native-step')
    $supervisor.observations += @{ stage = $supervisor.stage; result = $observation }; Save-PreparedProgress
    if ($observation.error -or $observation.timedOut -or $observation.exitCode -ne 0) { throw 'Native export failed; reconcile retained native process.' }
    $data = $observation.stdout | ConvertFrom-Json
    if ($data.outcome -cne 'passed' -or $data.role -cne $Role -or $data.contextSha256 -cne $binding.context.sha256 -or
        $data.requestSha256 -cne $binding.requestSha256 -or $data.resultSha256 -cne $binding.resultSha256 -or
        $data.depthMm -ne $binding.depthMm -or $data.candidateRoot -ine $candidate -or
        $data.nativePid -ne $supervisor.native.pid -or $data.nativeStartTicks -cne $supervisor.native.ticks -or
        $data.nativeVersion -cne '30.5.0' -or $data.releaseErrors.Count -ne 0) { throw 'Native export evidence binding mismatch.' }
    foreach ($check in $data.checks.PSObject.Properties) {
        if ($check.Value -isnot [bool] -or -not $check.Value) { throw 'Native export predicate failed.' }
    }
    foreach ($required in @('initial_empty_ready', 'preview_whole_assembly_selection', 'step_save_success',
        'step_preferences_unchanged', 'single_bounded_step_file', 'step_exchange_envelope', 'final_empty', 'after_exact_native_file')) {
        if ($data.checks.$required -ne $true) { throw ('Required native check missing: ' + $required) }
    }
    Assert-PreviewIdentities $data.beforeNativeFiles $binding.nativeFiles
    Assert-PreviewIdentities $data.afterNativeFiles $binding.nativeFiles
    return $data
}

try {
    Save-PreparedProgress
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or -not [Environment]::Is64BitProcess -or
        $PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1) { throw 'Requires x64 Windows PowerShell 5.1.' }
    [void](Write-PreparedBytes (Join-Path $folder 'context.json') $binding.context.bytes)
    if ($binding.request) {
        [void](Write-PreparedBytes (Join-Path $folder 'request.json') $binding.request.bytes)
        [void](Write-PreparedBytes (Join-Path $folder 'candidate-result.json') $binding.receipt.bytes)
    }
    Confirm-PreviewInputs 'before'
    New-Item -ItemType Directory -Path (Join-Path $candidate 'parts') -ErrorAction Stop | Out-Null
    New-Item -ItemType Directory -Path (Split-Path -Parent $stepPath) -ErrorAction Stop | Out-Null
    foreach ($file in $binding.nativeFiles) { [IO.File]::Copy((Join-Path $SourceRoot $file.path), (Join-Path $candidate $file.path), $false) }
    Assert-PreviewIdentities (Measure-PreparedPackage $candidate) $binding.nativeFiles
    Copy-PreviewSources
    # Rebind only the allowlisted definitions from the exact retained driver copy.
    . (Get-PreviewRuntimeFunctions (Join-Path $folder 'dimension-run.ps1'))
    . (Join-Path $folder 'OwnedProcess.ps1')
    [Environment]::CurrentDirectory = $folder
    Assert-PreparedRuntime; Assert-PreparedNativeAbsent
    if ((Get-PreparedHash $swconst) -cne $swconstHash -or (Get-Item -LiteralPath $swconst).Length -ne 454808 -or
        [Reflection.AssemblyName]::GetAssemblyName($swconst).Version.ToString() -cne '30.5.0.49') { throw 'STEP constants identity differs.' }
    Build-PreviewHelpers
    [void](Write-PreparedJson (Join-Path $folder 'settings.json') (@{ candidateRoot = $candidate; stepPath = $stepPath;
        role = $Role; contextSha256 = $binding.context.sha256; requestSha256 = $binding.requestSha256;
        resultSha256 = $binding.resultSha256; nativeFiles = $binding.nativeFiles; depthMm = $binding.depthMm; swconstSha256 = $swconstHash }))
    $mutex = New-Object Threading.Mutex($false, 'Local\OverDrafterPreparedDimensionNative')
    try { $lockHeld = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $lockHeld = $true; throw 'Prior operator mutex was abandoned; reconcile before another attempt.' }
    if (-not $lockHeld) { throw 'Another prepared native operation is active.' }
    Assert-PreparedNativeAbsent; Assert-PreparedRuntime
    $native = New-Object Diagnostics.Process
    $native.StartInfo.FileName = $exe; $native.StartInfo.WorkingDirectory = $folder
    $native.StartInfo.UseShellExecute = $false; $native.StartInfo.CreateNoWindow = $true
    $native.StartInfo.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
    $supervisor.stage = 'start_native'; $supervisor.nativeStartAttempted = $true; Save-PreparedProgress
    if (-not $native.Start()) { throw 'Native process start returned false.' }
    $supervisor.nativeStarted = $true; $supervisor.nativePid = $native.Id; $null = $native.Handle
    $supervisor.native = @{ pid = $native.Id; ticks = $native.StartTime.ToUniversalTime().Ticks.ToString();
        session = $native.SessionId; path = $native.MainModule.FileName }
    Save-PreparedProgress; Wait-PreparedNativeReady
    $nativeData = Invoke-PreviewExport
    [void](Invoke-PreparedLifecycle 'graceful-close-empty' 'close-native')
    if (-not $native.WaitForExit(30000)) { throw 'Native exit is unconfirmed.' }
    $supervisor.nativeExit = $native.ExitCode
    if ($supervisor.nativeExit -ne 0) { throw 'Native exit was nonzero.' }
    Assert-PreparedNativeAbsent
    Assert-PreviewIdentities (Measure-PreparedPackage $candidate) $binding.nativeFiles
    $result.outcome = 'succeeded'; $result.failureReason = $null
} catch { Fail-PreparedAttempt $_.Exception.Message }
finally {
    try { Confirm-PreviewInputs 'final' } catch { Fail-PreparedAttempt ('Source preservation: ' + $_.Exception.Message) }
    if ($native) {
        try {
            if ($supervisor.nativeStarted) {
                $supervisor.nativeHasExited = $native.HasExited
                if ($native.HasExited) { $supervisor.nativeExit = $native.ExitCode }
            }
            $native.Dispose()
        } catch { Fail-PreparedAttempt ('Final native observation/disposal: ' + $_.Exception.Message) }
    }
    try { [Environment]::CurrentDirectory = $previousDirectory } catch { Fail-PreparedAttempt ('Working directory: ' + $_.Exception.Message) }
    if ($mutex) {
        try { if ($lockHeld) { $mutex.ReleaseMutex() }; $mutex.Dispose() }
        catch { Fail-PreparedAttempt ('Operator mutex: ' + $_.Exception.Message) }
    }
}
try {
    $bundleBytes = $null
    if ($result.outcome -ceq 'succeeded') {
        [byte[]]$stepBytes = [IO.File]::ReadAllBytes($stepPath)
        if ($nativeData.step.fileName -cne 'assembly.step' -or $nativeData.step.bytes -ne $stepBytes.Length -or
            $nativeData.step.sha256 -cne (Get-PreparedBytesHash $stepBytes)) { throw 'STEP bytes differ from the native report.' }
        $reportHash = Get-PreparedHash (Join-Path $folder 'native-step.stdout.txt')
        $bundleBytes = New-PreviewBundle $binding $stepBytes $reportHash $commitLabel
        $supervisor.stage = 'completed'
    }
    [void](Write-PreparedJson (Join-Path $folder 'supervisor-final.json') $supervisor)
    if ($result.outcome -ceq 'succeeded') {
        [void](Write-PreparedBytes (Join-Path $folder 'preview.json') $bundleBytes)
        Write-Output (Join-Path $folder 'preview.json'); exit 0
    }
} catch { Fail-PreparedAttempt ('Final preview receipt: ' + $_.Exception.Message); Save-PreparedProgress }
Write-Output ($result | ConvertTo-Json -Depth 5)
Write-Output (Join-Path $folder 'supervisor-final.json')
exit 2
