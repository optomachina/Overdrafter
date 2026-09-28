#requires -Version 5.1
# Trusted-owner runtime bundle. Hash pins bind source/toolchain bytes; they do not
# qualify CAD or authenticate a hostile process running as the same Windows user.
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'CompanionState.ps1')
. (Join-Path $PSScriptRoot 'CompanionStore.ps1')
function Get-CompanionRuntimeSources {
    return @(Get-ChildItem -LiteralPath ([IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))) -Recurse -File |
        Where-Object { $_.Extension -cin @('.ps1','.cs') } | Sort-Object FullName | ForEach-Object { $_.FullName })
}
function Get-CompanionRuntimeFile([string]$Path) {
    $path=Assert-CompanionLocalPath $Path
    return [pscustomobject]@{path=$path;sha256=(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()}
}
# Keeps every admitted file open without write/delete sharing until observation
# ends. A missing, substituted or extra compiler dependency rejects before launch.
function Open-CompanionRuntime([string]$ProfilePath,[string]$ProfileSha256) {
    Assert-CompanionWindows
    if ($PSVersionTable.PSVersion.Major -ne 5 -or $ProfileSha256 -cnotmatch '^[0-9a-f]{64}$') { throw 'Pinned Windows PowerShell 5.1 runtime required.' }
    $locks=New-Object 'System.Collections.Generic.List[System.IO.FileStream]'
    try {
        $profilePath=Assert-CompanionLocalPath $ProfilePath
        $locks.Add([IO.File]::Open($profilePath,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read))
        if ((Get-CompanionRuntimeFile $profilePath).sha256 -cne $ProfileSha256) { throw 'Runtime profile hash differs.' }
        $profile=ConvertFrom-CompanionJson ([IO.File]::ReadAllText($profilePath))
        Assert-CompanionKeys $profile @('schema','engine','host','detached','admission','compiler','references','sources')
        if ($profile.schema -cne 'overdrafter.companion-runtime.v1') { throw 'Unsupported runtime profile.' }
        Assert-CompanionKeys $profile.compiler @('path','sha256','version','profile','files')
        if ($profile.compiler.profile -cne 'standalone-roslyn-noconfig-v1' -or
            [IO.Path]::GetFileName($profile.compiler.path) -cne 'csc.exe' -or
            $profile.compiler.version -cne [Diagnostics.FileVersionInfo]::GetVersionInfo($profile.compiler.path).ProductVersion) { throw 'Standalone compiler profile differs.' }
        $compilerRoot=[IO.Path]::GetDirectoryName($profile.compiler.path)
        if (-not [IO.File]::Exists((Join-Path $compilerRoot 'Microsoft.CodeAnalysis.CSharp.dll'))) { throw 'Standalone Roslyn bundle required; no legacy fallback.' }
        $actualCompiler=@(Get-ChildItem -LiteralPath $compilerRoot -Recurse -File | Sort-Object FullName | ForEach-Object { $_.FullName })
        $expectedCompiler=@($profile.compiler.files | ForEach-Object { $_.path } | Sort-Object)
        if (($actualCompiler -join "`n") -cne ($expectedCompiler -join "`n")) { throw 'Compiler dependency inventory differs.' }
        $sourcePaths=@($profile.sources | ForEach-Object { $_.path } | Sort-Object)
        if (((Get-CompanionRuntimeSources) -join "`n") -cne ($sourcePaths -join "`n")) { throw 'Runtime source inventory differs.' }
        if ($profile.engine.path -cne [Management.Automation.PowerShell].Assembly.Location) { throw 'PowerShell engine path differs.' }
        $framework=Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
        $expectedReferences=@('mscorlib.dll','System.dll','System.Core.dll','System.Web.Extensions.dll') | ForEach-Object { Join-Path $framework $_ }
        if (($expectedReferences -join "`n") -cne (@($profile.references | ForEach-Object { $_.path }) -join "`n")) { throw 'Explicit Framework references differ.' }
        $files=@($profile.engine,$profile.host,$profile.detached,$profile.admission)+@($profile.compiler.files)+@($profile.references)+@($profile.sources)
        foreach ($file in $files) {
            Assert-CompanionKeys $file @('path','sha256')
            $path=Assert-CompanionLocalPath $file.path
            if ($file.sha256 -cnotmatch '^[0-9a-f]{64}$') { throw 'Invalid runtime file hash.' }
            $locks.Add([IO.File]::Open($path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read))
            if ((Get-CompanionRuntimeFile $path).sha256 -cne $file.sha256) { throw 'Pinned runtime file changed.' }
        }
        if ((Get-CompanionRuntimeFile $profile.compiler.path).sha256 -cne $profile.compiler.sha256) { throw 'Compiler executable changed.' }
        return [pscustomobject]@{profile=$profile;locks=$locks}
    } catch { foreach ($file in $locks) { $file.Dispose() }; throw }
}
function Close-CompanionRuntime($Runtime) {
    if ($null -ne $Runtime) { foreach ($file in $Runtime.locks) { $file.Dispose() } }
}
# Load only the prebuilt pinned assemblies; never compile within observation.
function Import-CompanionRuntime($Runtime) {
    foreach ($name in @('detached','admission')) { $null=[Reflection.Assembly]::LoadFrom($Runtime.profile.$name.path) }
    if ([OverDrafter.StopObserver.DetachedProcess].Assembly.Location -cne $Runtime.profile.detached.path -or
        [PreparedFilesystemAdmission].Assembly.Location -cne $Runtime.profile.admission.path) { throw 'An incompatible runtime assembly was already loaded.' }
}
# Observer and authority loop use separate runspaces in the trusted companion
# process, outside the prepared root's Windows job. Only the root gets pipe
# client ends; no worker credential is passed into its process or the observer.
function Start-CompanionObservation($Request,$Runtime,[string[]]$Arguments,[string]$WorkingDirectory,[string]$OutputDirectory,$Channels) {
    $observer=Join-Path $PSScriptRoot '../stop-observer/Observer.ps1'
    $pipeline=[Management.Automation.PowerShell]::Create()
    try {
        $null=$pipeline.AddScript({param($Observer,$Request,$Executable,$Arguments,$Directory,$Output,$Channels)
            $ErrorActionPreference='Stop'
            . $Observer
            Invoke-IndependentStopObserver -Request $Request -Executable $Executable -Arguments $Arguments `
                -WorkingDirectory $Directory -OutputDirectory $Output -AuthorityChannels $Channels -EnableObserver
        }).AddArgument($observer).AddArgument($Request).AddArgument($Runtime.profile.host.path).AddArgument($Arguments).AddArgument($WorkingDirectory).AddArgument($OutputDirectory).AddArgument($Channels)
        return [pscustomobject]@{pipeline=$pipeline;pending=$pipeline.BeginInvoke()}
    } catch { $pipeline.Dispose(); throw }
}
function Complete-CompanionObservation($Observation) {
    $results=@($Observation.pipeline.EndInvoke($Observation.pending))
    if ($Observation.pipeline.HadErrors -or $results.Count -ne 1 -or $results[0].stopAdmission -ne $false) { throw 'Independent observer did not complete.' }
    return $results[0]
}
