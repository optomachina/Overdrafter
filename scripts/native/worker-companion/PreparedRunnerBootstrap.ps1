#requires -Version 5.1
# Pinned non-console host entry. All assemblies are compiled before observation.
[CmdletBinding()]
param([string]$RuntimeProfilePath,[string]$RuntimeProfileSha256,[string]$RequestPath,[string]$ContextPath,
    [string]$PackageRoot,[string]$OutputRoot,[string]$SourceCommit,[string]$JournalBindingPath,[string]$DeadlineAt,
    [string]$AuthorityPath,[string]$AuthorityReadHandle,[string]$AuthorityWriteHandle)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'CompanionRuntime.ps1')
$runtime=$null
try {
    $runtime=Open-CompanionRuntime $RuntimeProfilePath $RuntimeProfileSha256
    Import-CompanionRuntime $runtime
    $parameters=@{Execute=$true;RequestPath=$RequestPath;ContextPath=$ContextPath;PackageRoot=$PackageRoot;OutputRoot=$OutputRoot;
        SourceCommit=$SourceCommit;JournalBindingPath=$JournalBindingPath;DeadlineAt=$DeadlineAt;AuthorityPath=$AuthorityPath;
        AuthorityReadHandle=$AuthorityReadHandle;AuthorityWriteHandle=$AuthorityWriteHandle;QualifiedRuntime=$runtime.profile}
    . (Join-Path $PSScriptRoot '../prepared-dimension/run.ps1') @parameters
} finally { Close-CompanionRuntime $runtime }
