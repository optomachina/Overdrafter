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
        for ($index=1; $index -le 350; $index++) {
            if ((Receive-CompanionAuthorityFrame $channel.incoming 5000) -cne ('exact-inert-probe-'+$index)) { throw 'Request differs.' }
            Send-CompanionAuthorityFrame $channel.outgoing ('exact-inert-ack-'+$index)
        }
    } finally { Close-CompanionAuthorityPipe $channel }
    Start-Sleep -Milliseconds 1000
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
    $poll=New-CompanionAuthorityRead $channel.incoming
    $timer=[Diagnostics.Stopwatch]::StartNew()
    for ($index=1; $index -le 350; $index++) {
        Send-CompanionAuthorityFrame $channel.outgoing ('exact-inert-probe-'+$index)
        $response=$null; $deadline=[DateTimeOffset]::UtcNow.AddSeconds(5)
        while ($null -eq $response -and [DateTimeOffset]::UtcNow -lt $deadline) {
            $response=Receive-CompanionAuthorityPoll $poll
            if ($null -eq $response) { Start-Sleep -Milliseconds 5 }
        }
        if ($response -cne ('exact-inert-ack-'+$index)) { throw 'Child response differs.' }
    }
    $timer.Stop()
    if ($timer.ElapsedMilliseconds -gt 30000) { throw '350 inert authority frames exceeded budget.' }
    $eofDeadline=[DateTimeOffset]::UtcNow.AddSeconds(3)
    while (-not $poll.closed -and [DateTimeOffset]::UtcNow -lt $eofDeadline) {
        $null=Receive-CompanionAuthorityPoll $poll
        if (-not $poll.closed) { Start-Sleep -Milliseconds 5 }
    }
    if (-not $poll.closed -or $process.HasExited) { throw 'Clean authority EOF before terminal root was not preserved.' }
    $partial=[IO.MemoryStream]::new([byte[]]@(1,0))
    try {
        $truncated=New-CompanionAuthorityRead $partial; $denied=$false
        try { $null=Receive-CompanionAuthorityPoll $truncated } catch { $denied=$_.ToString() -match 'closed during a frame' }
        if (-not $denied) { throw 'Truncated authority frame was treated as clean EOF.' }
    } finally { $partial.Dispose() }
    if (-not $process.WaitForExit(5000) -or $process.ExitCode -ne 0) { throw 'Synthetic pipe child did not exit cleanly.' }
    [pscustomobject]@{schema='overdrafter.anonymous-pipe-proof.v1';passed=$true;
        nativeActions=0;network=$false;credentials=$false;roundtrips=350;
        elapsedMs=$timer.ElapsedMilliseconds} | ConvertTo-Json -Compress
} finally {
    if ($started -and -not $process.HasExited) { $process.Kill(); $null=$process.WaitForExit(5000) }
    $process.Dispose(); Close-CompanionAuthorityPipe $channel
}
