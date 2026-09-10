#requires -Version 5.1
<#
.SYNOPSIS
Qualifies only synthetic journal storage in a retained private Windows folder.
.DESCRIPTION
Default-off; never pairs a worker or launches CAD. Preserve all generated files,
including the intentionally failed replacement's pending ciphertext.
#>
[CmdletBinding()]
param([switch]$QualifyStorage)
if (-not $QualifyStorage) { throw 'Explicit -QualifyStorage is required.' }
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'JournalStore.ps1')
Assert-CompanionWindows
$script:checks=0
function Assert-StorageCase([bool]$Value,[string]$Label) { $script:checks++; if (-not $Value) { throw ('Storage qualification failed: '+$Label) } }
function Assert-StorageDenial([scriptblock]$Action,[string]$Label) { $failed=$false; try { & $Action | Out-Null } catch { $failed=$true }; Assert-StorageCase $failed $Label }
function Get-CipherDigest([string]$Path) {
    $hash=[Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($hash.ComputeHash([IO.File]::ReadAllBytes($Path))).Replace('-','').ToLowerInvariant() }
    finally { $hash.Dispose() }
}
$binding=[pscustomobject]@{organizationId=[Guid]::NewGuid().ToString();projectId=[Guid]::NewGuid().ToString();workerId=[Guid]::NewGuid().ToString();
    installationId=[Guid]::NewGuid().ToString();bootId=[Guid]::NewGuid().ToString();taskId=[Guid]::NewGuid().ToString();attemptId=[Guid]::NewGuid().ToString();
    jobId=[Guid]::NewGuid().ToString();fence=1;jobSha256=('a'*64);runtimeAdmissionId=[Guid]::NewGuid().ToString()}
$store=$null; $reader=$null
try {
    Assert-StorageDenial { Open-NativeJournalStore $binding $false } 'missing history is not created by read'
    $store=Open-NativeJournalStore $binding $true
    $journal=New-NativeJournal $binding
    Save-NativeJournalStore $store $journal
    Assert-StorageCase ((Read-NativeJournalStore $store).headSha256 -ceq $journal.headSha256) 'initial encrypted readback'
    Assert-StorageDenial { Open-NativeJournalStore $binding $false } 'exclusive ownership'
    $launchEvent=[pscustomobject]@{launchId=[Guid]::NewGuid().ToString();role='compiler';executablePath='C:\Synthetic\compiler.exe';executableSha256=('b'*64);
        workingDirectory='C:\Synthetic\attempt';argumentsSha256=('c'*64);parentLaunchId=$null}
    $next=Add-NativeJournalEvent $journal launch_intent $launchEvent ([DateTime]::UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'"))
    Save-NativeJournalStore $store $next
    Assert-StorageCase ($store.count -eq 1 -and $store.head -ceq $next.headSha256) 'acknowledged append'
    Assert-StorageDenial { Save-NativeJournalStore $store $journal } 'rollback refused'
    Assert-StorageDenial { Save-NativeJournalStore $store $next } 'duplicate append refused'
    $store.lock.Dispose(); $store=$null
    $store=Open-NativeJournalStore $binding $false
    Assert-StorageCase ($store.head -ceq $next.headSha256 -and $store.count -eq 1) 'restart reads original history'
    Assert-StorageCase ((Get-NativeJournalSummary (Read-NativeJournalStore $store)).recoveryRequired) 'unresolved launch survives restart'
    $before=Get-CipherDigest $store.statePath
    $reader=New-Object IO.FileStream($store.statePath,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    $uncertain=Add-NativeJournalEvent $next uncertain ([pscustomobject]@{reason='launch_gap'}) ([DateTime]::UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'"))
    Assert-StorageDenial { Save-NativeJournalStore $store $uncertain } 'locked destination denies atomic replacement'
    Assert-StorageCase ($store.poisoned -and $store.head -ceq $next.headSha256) 'uncertain write poisons handle without advancing acknowledgement'
    $reader.Dispose(); $reader=$null
    Assert-StorageCase ((Get-CipherDigest $store.statePath) -ceq $before) 'failed replacement preserves prior ciphertext'
    Assert-StorageDenial { Save-NativeJournalStore $store $uncertain } 'poisoned handle cannot continue'
    Assert-StorageCase (@([IO.Directory]::GetFiles($store.root,'*.pending.dpapi')).Count -eq 1) 'failed pending ciphertext retained'
    $store.lock.Dispose(); $store=$null
    $store=Open-NativeJournalStore $binding $false
    Assert-StorageCase ($store.head -ceq $next.headSha256) 'fresh read retains last acknowledged checkpoint'
    $store.lock.Dispose(); $store=$null
    $wrong=ConvertFrom-CompanionJson (ConvertTo-JournalJson $binding); $wrong.bootId=[Guid]::NewGuid().ToString()
    Assert-StorageDenial { Open-NativeJournalStore $wrong $false } 'new boot cannot rewrite original attempt binding'
    [pscustomobject]@{schema='overdrafter.journal-storage-qualification.v1';passed=$true;assertions=$script:checks;
        workerId=$binding.workerId;attemptId=$binding.attemptId;headSha256=$next.headSha256;retained=$true;nativeActions=0} | ConvertTo-Json -Compress
} finally {
    if ($null -ne $reader) { $reader.Dispose() }
    if ($null -ne $store -and $null -ne $store.lock) { $store.lock.Dispose() }
}
