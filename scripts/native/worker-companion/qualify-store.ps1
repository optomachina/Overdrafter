#requires -Version 5.1
# Windows-only synthetic storage qualification. No endpoint, production worker,
# general database credential or native CAD process is used. Retains ciphertext.
[CmdletBinding()]
param([switch]$Qualify)
if(-not $Qualify){throw 'Default-off: -Qualify is required for synthetic Windows storage tests.'}
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'CompanionState.ps1')
. (Join-Path $PSScriptRoot 'CompanionStore.ps1')
Assert-CompanionWindows
$script:count=0; $store=$null
function Check([bool]$Value,[string]$Label){$script:count++;if(-not $Value){throw ('Storage qualification failed: '+$Label)}}
function Fails([scriptblock]$Operation,[string]$Label){$failed=$false;try{& $Operation | Out-Null}catch{$failed=$true};Check $failed $Label}
try {
    $worker=[Guid]::NewGuid().ToString()
    $state=New-CompanionState $worker 'https://example.invalid/functions/v1/engineering-worker' (New-CompanionSecret pairing)
    $store=Open-CompanionStore $worker $true
    Check $store.isNew 'new synthetic worker directory'
    Save-CompanionStore $store $state
    $read=Read-CompanionStore $store
    Check (($read | ConvertTo-Json -Depth 20 -Compress) -ceq ($state | ConvertTo-Json -Depth 20 -Compress)) 'CurrentUser DPAPI roundtrip'
    $cipher=[IO.File]::ReadAllBytes($store.statePath)
    Check (-not [Text.Encoding]::UTF8.GetString($cipher).Contains($state.token)) 'raw token absent from ciphertext'
    Check (-not [Text.Encoding]::UTF8.GetString($cipher).Contains($state.pending.pairingCode)) 'raw pairing code absent from ciphertext'
    Fails { $second=Open-CompanionStore $worker $false; $second.lock.Dispose() } 'exclusive owner lock'
    $state.paired=$true; $state.pending=$null; $state.revision=2
    Save-CompanionStore $store $state
    Check ((Read-CompanionStore $store).paired) 'atomic replacement and readback'
    Assert-CompanionPrivateAcl $store.statePath $store.sid $false
    Check $true 'replacement preserves protected owner ACL'
    $cipher=[IO.File]::ReadAllBytes($store.statePath)
    $tampered=[byte[]]$cipher.Clone(); $tampered[0]=$tampered[0] -bxor 1
    try {
        [IO.File]::WriteAllBytes($store.statePath,$tampered)
        Fails {Read-CompanionStore $store} 'tampered ciphertext refused'
    } finally {[IO.File]::WriteAllBytes($store.statePath,$cipher)}
    $store.workerId=[Guid]::NewGuid().ToString()
    try {Fails {Read-CompanionStore $store} 'wrong worker entropy refused'} finally {$store.workerId=$worker}
    $root=$store.root; $store.lock.Dispose(); $store=$null
    $store=Open-CompanionStore $worker $false
    Check (-not $store.isNew -and (Read-CompanionStore $store).paired) 'restart reopens retained encrypted state'
    [pscustomobject]@{schema='overdrafter.companion-storage-qualification.v1';assertions=$script:count;passed=$true;
        runtime=$PSVersionTable.PSVersion.ToString();os=[Environment]::OSVersion.VersionString;retainedSyntheticRoot=$root;
        sameUserDpapi=$true;otherUserAccessTested=$false;httpsQualified=$false;nativeActions=0;productionChanged=$false} | ConvertTo-Json
} catch {
    # Return only structural diagnostics; never serialize the exception message,
    # stack, invocation text or state, which can contain private values.
    [pscustomobject]@{schema='overdrafter.companion-storage-qualification.v1';assertions=$script:count;passed=$false;
        runtime=$PSVersionTable.PSVersion.ToString();failure=[pscustomobject]@{
            type=$_.Exception.GetType().FullName;causeType=$_.Exception.GetBaseException().GetType().FullName;
            file=[IO.Path]::GetFileName($_.InvocationInfo.ScriptName);line=$_.InvocationInfo.ScriptLineNumber};
        httpsQualified=$false;nativeActions=0;productionChanged=$false} | ConvertTo-Json -Depth 4
    Write-Error 'Synthetic Windows storage qualification failed. Retain its directory for diagnosis.' -ErrorAction Continue
    exit 1
} finally {if($null -ne $store -and $null -ne $store.lock){$store.lock.Dispose()}}
exit 0
