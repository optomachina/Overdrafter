#requires -Version 5.1
# Inert Windows proof that two ACL-at-creation anonymous handles reach only a
# directly started child and support bounded request/response without a token.
[CmdletBinding()]
param([switch]$Child,[string]$ReadHandle,[string]$WriteHandle)
$ErrorActionPreference='Stop'; Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'CompanionAuthorityPipe.ps1')
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or
    $PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1) {
    throw 'Anonymous-pipe proof requires Windows PowerShell 5.1.'
}
if ($Child) {
    $channel=Open-RunnerAuthorityPipe $ReadHandle $WriteHandle
    try {
        if ((Receive-CompanionAuthorityFrame $channel.incoming 5000) -cne 'exact-inert-probe') { throw 'Request differs.' }
        Send-CompanionAuthorityFrame $channel.outgoing 'exact-inert-ack'
    } finally { Close-CompanionAuthorityPipe $channel }
    exit 0
}
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
try { $sid=$identity.User } finally { $identity.Dispose() }
$channel=New-CompanionAuthorityPipe $sid
$process=[Diagnostics.Process]::new()
$started=$false
try {
    $readHandle=$channel.readHandle
    $writeHandle=$channel.writeHandle
    $process.StartInfo.FileName=Join-Path $PSHOME 'powershell.exe'
    $process.StartInfo.Arguments='-NoProfile -NonInteractive -File "'+$PSCommandPath+'" -Child -ReadHandle '+$readHandle+' -WriteHandle '+$writeHandle
    $process.StartInfo.UseShellExecute=$false; $process.StartInfo.CreateNoWindow=$true
    $process.StartInfo.RedirectStandardOutput=$true; $process.StartInfo.RedirectStandardError=$true
    if (-not $process.Start()) { throw 'Synthetic pipe child did not start.' }
    $started=$true
    $channel.outgoing.DisposeLocalCopyOfClientHandle(); $channel.incoming.DisposeLocalCopyOfClientHandle()
    Send-CompanionAuthorityFrame $channel.outgoing 'exact-inert-probe'
    if ((Receive-CompanionAuthorityFrame $channel.incoming 5000) -cne 'exact-inert-ack') { throw 'Child response differs.' }
    if (-not $process.WaitForExit(5000) -or $process.ExitCode -ne 0) { throw 'Synthetic pipe child did not exit cleanly.' }
    [pscustomobject]@{schema='overdrafter.anonymous-pipe-proof.v1';passed=$true;
        nativeActions=0;network=$false;credentials=$false;roundtrips=1} | ConvertTo-Json -Compress
} finally {
    if ($started -and -not $process.HasExited) { $process.Kill(); $null=$process.WaitForExit(5000) }
    $process.Dispose(); Close-CompanionAuthorityPipe $channel
}
