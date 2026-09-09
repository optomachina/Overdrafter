#requires -Version 5.1
<#
.SYNOPSIS
Hashes the exact three synthetic files and writes a BOM-free context. Makes no CAD calls.
#>
[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$PackageRoot, [Parameter(Mandatory = $true)][string]$OutputPath)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'WireContract.ps1')
$PackageRoot = Resolve-PreparedLocalPath $PackageRoot
$OutputPath = Resolve-PreparedLocalPath $OutputPath
if ($OutputPath.Equals($PackageRoot, [StringComparison]::OrdinalIgnoreCase) -or
    $OutputPath.StartsWith($PackageRoot.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Context output must be outside the original package.'
}
$files = Measure-PreparedPackage $PackageRoot -RequireOriginal
$context = [ordered]@{
    schema = 'overdrafter.prepared-assembly.v1'; packageId = 'ovd-native04-assembly';
    scope = @{ organizationId = 'local-engineering'; projectId = 'prepared-assembly' };
    capturedAt = [DateTime]::UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'");
    configuration = 'Default'; assemblyPath = 'synthetic-assembly.SLDASM'; files = $files;
    dimension = @{ id = 'baseline-depth'; occurrence = 'baseline-5mm-1'; feature = 'OVD_QualificationExtrusion';
        partPath = 'parts/baseline-5mm.SLDPRT'; unit = 'mm'; baseline = 5; minimum = 6; maximum = 10 };
    limitations = $PreparedLimitations
}
$digest = Write-PreparedJson (Resolve-PreparedLocalPath $OutputPath) $context
Write-Output (@{ path = $OutputPath; sha256 = $digest; evidence = 'file_hashing_only_no_native_action' } | ConvertTo-Json)
