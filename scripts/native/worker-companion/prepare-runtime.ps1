#requires -Version 5.1
# Offline source preparation only. No worker account, native job or CAD operation.
[CmdletBinding()]
param([switch]$Prepare,[Parameter(Mandatory=$true)][string]$OutputDirectory,[Parameter(Mandatory=$true)][string]$CompilerPath)
if (-not $Prepare) { throw 'Default-off: explicit -Prepare is required.' }
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'CompanionRuntime.ps1')
Assert-CompanionWindows
if ($PSVersionTable.PSVersion.Major -ne 5) { throw 'Windows PowerShell 5.1 is required.' }
$output=Assert-CompanionLocalPath $OutputDirectory
$compiler=Get-CompanionRuntimeFile $CompilerPath
$compilerRoot=[IO.Path]::GetDirectoryName($compiler.path)
if ([IO.Path]::GetFileName($compiler.path) -cne 'csc.exe' -or -not [IO.File]::Exists((Join-Path $compilerRoot 'Microsoft.CodeAnalysis.CSharp.dll'))) { throw 'Explicit installed standalone Roslyn compiler required.' }
if ([IO.Directory]::Exists($output) -or [IO.File]::Exists($output)) { throw 'Runtime output must be fresh.' }
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
try { $sid=$identity.User } finally { $identity.Dispose() }
$directory=New-Object IO.DirectoryInfo($output); $directory.Create((New-CompanionAcl $sid $true))
$observer=Join-Path $PSScriptRoot '../stop-observer'
$hostPath=Join-Path $output 'PreparedPowerShellHost.exe'
$detached=Join-Path $output 'DetachedLauncher.dll'
$admission=Join-Path $output 'PreparedFilesystemAdmission.dll'
# Preparation occurs before the observed attempt; compiler subprocesses here are
# not represented as part of a prepared job's process-stop certificate.
Add-Type -Path (Join-Path $observer 'PreparedPowerShellHost.cs') -ReferencedAssemblies @('System.dll','System.Core.dll',[Management.Automation.PowerShell].Assembly.Location) -OutputAssembly $hostPath -OutputType WindowsApplication
Add-Type -Path @((Join-Path $observer 'DetachedProcess.cs'),(Join-Path $observer 'JobBoundary.cs')) -OutputAssembly $detached
$admissionSource=Join-Path $PSScriptRoot '../file-admission/PreparedFilesystemAdmission.cs'
$sourceHash=(Get-CompanionRuntimeFile $admissionSource).sha256
$binding="public static class PreparedFilesystemAdmissionSourceBinding { public const string SourceSha256 = `"$sourceHash`"; }"
Add-Type -TypeDefinition ([IO.File]::ReadAllText($admissionSource)+[Environment]::NewLine+$binding) -OutputAssembly $admission
$framework=Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
$profile=[pscustomobject]@{schema='overdrafter.companion-runtime.v1';engine=(Get-CompanionRuntimeFile ([Management.Automation.PowerShell].Assembly.Location));
    host=(Get-CompanionRuntimeFile $hostPath);detached=(Get-CompanionRuntimeFile $detached);admission=(Get-CompanionRuntimeFile $admission);
    compiler=[pscustomobject]@{path=$compiler.path;sha256=$compiler.sha256;version=[Diagnostics.FileVersionInfo]::GetVersionInfo($compiler.path).ProductVersion;
        profile='standalone-roslyn-noconfig-v1';files=@(Get-ChildItem -LiteralPath $compilerRoot -Recurse -File | Sort-Object FullName | ForEach-Object { Get-CompanionRuntimeFile $_.FullName })};
    references=@(@('mscorlib.dll','System.dll','System.Core.dll','System.Web.Extensions.dll') | ForEach-Object { Get-CompanionRuntimeFile (Join-Path $framework $_) });
    sources=@(Get-CompanionRuntimeSources | ForEach-Object { Get-CompanionRuntimeFile $_ })}
$profilePath=Join-Path $output 'runtime-profile.json'
[IO.File]::WriteAllText($profilePath,($profile | ConvertTo-Json -Depth 8),(New-Object Text.UTF8Encoding($false)))
[pscustomobject]@{profilePath=$profilePath;sha256=(Get-CompanionRuntimeFile $profilePath).sha256;nativeQualification=$false;liveActivation=$false} | ConvertTo-Json -Compress
