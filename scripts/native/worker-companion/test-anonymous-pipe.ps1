#requires -Version 5.1
# Inert Windows proof that two ACL-at-creation anonymous handles reach only a
# directly started child and support bounded request/response without a token.
[CmdletBinding()]
param([switch]$Child,[string]$ReadHandle,[string]$WriteHandle)
$ErrorActionPreference='Stop'; Set-StrictMode -Version Latest
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or
    $PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1) {
    throw 'Anonymous-pipe proof requires Windows PowerShell 5.1.'
}
function Read-BoundedLine($Reader,[int]$TimeoutMs) {
    $pending=$Reader.ReadLineAsync()
    if (-not $pending.Wait($TimeoutMs)) { throw 'Anonymous pipe read exceeded bound.' }
    return $pending.Result
}
if ($Child) {
    if ($ReadHandle -cnotmatch '^[0-9]+$' -or $WriteHandle -cnotmatch '^[0-9]+$') { throw 'Inherited handles differ.' }
    $incoming=[IO.Pipes.AnonymousPipeClientStream]::new([IO.Pipes.PipeDirection]::In,$ReadHandle)
    $outgoing=[IO.Pipes.AnonymousPipeClientStream]::new([IO.Pipes.PipeDirection]::Out,$WriteHandle)
    try {
        $reader=[IO.StreamReader]::new($incoming)
        $writer=[IO.StreamWriter]::new($outgoing); $writer.AutoFlush=$true
        if ((Read-BoundedLine $reader 5000) -cne 'exact-inert-probe') { throw 'Request differs.' }
        $writer.WriteLine('exact-inert-ack')
    } finally { $incoming.Dispose(); $outgoing.Dispose() }
    exit 0
}
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
try { $sid=$identity.User } finally { $identity.Dispose() }
$acl=[IO.Pipes.PipeSecurity]::new()
$acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false)
$acl.AddAccessRule([IO.Pipes.PipeAccessRule]::new($sid,[IO.Pipes.PipeAccessRights]::ReadWrite,
    [Security.AccessControl.AccessControlType]::Allow))
$toChild=[IO.Pipes.AnonymousPipeServerStream]::new([IO.Pipes.PipeDirection]::Out,
    [IO.HandleInheritability]::Inheritable,4096,$acl)
$fromChild=[IO.Pipes.AnonymousPipeServerStream]::new([IO.Pipes.PipeDirection]::In,
    [IO.HandleInheritability]::Inheritable,4096,$acl)
$process=[Diagnostics.Process]::new()
$started=$false
try {
    $readHandle=$toChild.GetClientHandleAsString()
    $writeHandle=$fromChild.GetClientHandleAsString()
    $process.StartInfo.FileName=Join-Path $PSHOME 'powershell.exe'
    $process.StartInfo.Arguments='-NoProfile -NonInteractive -File "'+$PSCommandPath+'" -Child -ReadHandle '+$readHandle+' -WriteHandle '+$writeHandle
    $process.StartInfo.UseShellExecute=$false; $process.StartInfo.CreateNoWindow=$true
    $process.StartInfo.RedirectStandardOutput=$true; $process.StartInfo.RedirectStandardError=$true
    if (-not $process.Start()) { throw 'Synthetic pipe child did not start.' }
    $started=$true
    $toChild.DisposeLocalCopyOfClientHandle(); $fromChild.DisposeLocalCopyOfClientHandle()
    $writer=[IO.StreamWriter]::new($toChild); $writer.AutoFlush=$true
    $reader=[IO.StreamReader]::new($fromChild)
    $writer.WriteLine('exact-inert-probe')
    if ((Read-BoundedLine $reader 5000) -cne 'exact-inert-ack') { throw 'Child response differs.' }
    if (-not $process.WaitForExit(5000) -or $process.ExitCode -ne 0) { throw 'Synthetic pipe child did not exit cleanly.' }
    [pscustomobject]@{schema='overdrafter.anonymous-pipe-proof.v1';passed=$true;
        nativeActions=0;network=$false;credentials=$false;roundtrips=1} | ConvertTo-Json -Compress
} finally {
    if ($started -and -not $process.HasExited) { $process.Kill(); $null=$process.WaitForExit(5000) }
    $process.Dispose(); $toChild.Dispose(); $fromChild.Dispose()
}
