#requires -Version 5.1
# Portable stream and admission tests. No actual network or credential files.
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'CompanionState.ps1')
. (Join-Path $PSScriptRoot 'CompanionStore.ps1')
. (Join-Path $PSScriptRoot 'CompanionHttp.ps1')
$script:count=0
function Check([bool]$Value,[string]$Label) { $script:count++; if(-not $Value){throw ('Boundary assertion failed: '+$Label)} }
function Fails([scriptblock]$Operation,[string]$Label) {
    $failed=$false; try { & $Operation | Out-Null } catch {$failed=$true}; Check $failed $Label
}
if ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT) {
    & {
        # Inject only drive metadata; no network drive is mapped or accessed.
        function New-Object([string]$TypeName,$ArgumentList) {
            if ($TypeName -cne 'IO.DriveInfo') { throw 'Unexpected storage operation.' }
            return [pscustomobject]@{DriveType=[IO.DriveType]::Network}
        }
        $message=$null
        try { Assert-CompanionLocalPath 'Z:\synthetic-companion\state.dpapi' | Out-Null } catch { $message=$_.Exception.Message }
        Check ($message -ceq 'Companion state requires a local Windows volume.') 'mapped network volume refused before filesystem access'
    }
}
$cancel=New-Object Threading.CancellationTokenSource
try {
    foreach($size in @(0,1,4096,32768)) {
        $bytes=[Text.Encoding]::UTF8.GetBytes(('a'*$size)); $stream=New-Object IO.MemoryStream(,$bytes)
        try { Check ((Read-CompanionHttpBody $stream $cancel.Token).Length -eq $size) 'permitted response body length' } finally {$stream.Dispose()}
    }
    $stream=New-Object IO.MemoryStream(,[Text.Encoding]::UTF8.GetBytes(('a'*32769)))
    try { Fails {Read-CompanionHttpBody $stream $cancel.Token} 'oversize actual stream rejected' } finally {$stream.Dispose()}
    $stream=New-Object IO.MemoryStream(,[byte[]]@(255,254,253))
    try { Fails {Read-CompanionHttpBody $stream $cancel.Token} 'invalid UTF8 rejected' } finally {$stream.Dispose()}
} finally {$cancel.Dispose()}
if (-not ('CompanionNeverReadStream' -as [type])) {
    Add-Type -TypeDefinition @'
using System.IO;
using System.Threading;
using System.Threading.Tasks;
public sealed class CompanionNeverReadStream : MemoryStream {
    public override Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken token) {
        return new TaskCompletionSource<int>().Task;
    }
}
'@
}
$stream=New-Object CompanionNeverReadStream; $cancel=New-Object Threading.CancellationTokenSource
try {
    $cancel.CancelAfter(20); $clock=[Diagnostics.Stopwatch]::StartNew()
    Fails {Read-CompanionHttpBody $stream $cancel.Token} 'uncooperative stream has a finite cancellation boundary'
    Check ($clock.ElapsedMilliseconds -lt 3000) 'cancelled wait does not wait for unfinished IO'
} finally {$cancel.Dispose();$stream.Dispose()}
foreach($endpoint in @('http://example.invalid/functions/v1/engineering-worker','https://example.invalid/other',
    'https://user:password@example.invalid/functions/v1/engineering-worker','https://example.invalid:444/functions/v1/engineering-worker',
    'https://example.invalid/functions/v1/engineering-worker?token=secret','https://example.invalid/functions/v1/engineering-worker#secret')) {
    Fails {Assert-CompanionEndpoint $endpoint} 'unadmitted endpoint rejected'
}
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or $PSVersionTable.PSEdition -cne 'Desktop') {
    Fails {Assert-CompanionWindows} 'unsupported runtime rejected'
    Fails {Open-CompanionStore ([Guid]::NewGuid().ToString()) $true} 'store cannot act on unsupported runtime'
    Fails {Send-CompanionHttp ([pscustomobject]@{}) ('odw_'+('a'*64)) 'https://example.invalid/functions/v1/engineering-worker'} 'HTTP cannot act on unsupported runtime'
}
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'run.ps1'),[ref]$tokens,[ref]$errors)
Check ($errors.Count -eq 0) 'launcher syntax'
# Run the actual default-off path in a new owned PowerShell process.
$binary=Join-Path $PSHOME 'pwsh'; if($PSVersionTable.PSEdition -ceq 'Desktop'){$binary=Join-Path $PSHOME 'powershell.exe'}
$PSNativeCommandUseErrorActionPreference=$false
$savedPreference=$ErrorActionPreference
try {
    # Windows PowerShell 5.1 turns redirected native stderr into error records.
    # This one child is expected to fail; restore strict behavior immediately.
    $ErrorActionPreference='Continue'
    $output=& $binary -NoProfile -File (Join-Path $PSScriptRoot 'run.ps1') 2>&1
    $childExit=$LASTEXITCODE
} finally {$ErrorActionPreference=$savedPreference}
Check ($childExit -ne 0 -and ($output | Out-String).Contains('Default-off')) 'default-off launcher refuses before configuration'
[pscustomobject]@{schema='overdrafter.companion-boundary-test.v1';assertions=$script:count;passed=$true;network=$false;
    credentialFiles=$false;windowsQualified=$false;nativeActions=0} | ConvertTo-Json
# The expected default-off child leaves LASTEXITCODE nonzero. This standalone
# suite succeeded only after every assertion above; report its own outcome.
exit 0
