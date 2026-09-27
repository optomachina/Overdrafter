#requires -Version 5.1
# Inert exact-effect test: a file marker replaces the CAD call. No credentials,
# network, SolidWorks, or customer files are present.
$ErrorActionPreference='Stop'; Set-StrictMode -Version Latest
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'Windows proof required.' }
$root=Join-Path $env:TEMP ('ovd562-effect-'+[Guid]::NewGuid().ToString())
[IO.Directory]::CreateDirectory($root) | Out-Null
try {
    $compiler=Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
    $target=Join-Path $root 'NativeEffectGateHarness.exe'
    & $compiler /nologo /target:exe ('/out:'+$target) /reference:System.Web.Extensions.dll `
        (Join-Path $PSScriptRoot '../prepared-dimension/NativeEffectGate.cs') `
        (Join-Path $PSScriptRoot 'NativeEffectGateHarness.cs')
    if ($LASTEXITCODE -ne 0 -or -not [IO.File]::Exists($target)) { throw 'Inert effect harness failed to compile.' }
    $checks=0
    foreach ($mode in @('valid','parent_closed','wrong_nonce','revoked','oversized','replayed')) {
        $folder=Join-Path $root $mode; [IO.Directory]::CreateDirectory($folder) | Out-Null
        $authority=Join-Path $folder 'authority.json'; $settingsPath=Join-Path $folder 'settings.json'
        $marker=Join-Path $folder 'native-marker.txt'
        $deadline=[DateTimeOffset]::UtcNow.AddMinutes(1).ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
        $lease=[DateTimeOffset]::UtcNow.AddSeconds(50).ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
        $taskId=[Guid]::NewGuid().ToString(); $attemptId=[Guid]::NewGuid().ToString()
        $record=[pscustomobject]@{schema='overdrafter.companion-task-authority.v1';
            attemptId=$attemptId;fence=7;deadlineAt=$deadline;leaseExpiresAt=$lease;revision=0}
        [IO.File]::WriteAllText($authority,($record | ConvertTo-Json -Compress))
        [IO.File]::WriteAllText($settingsPath,([pscustomobject]@{taskId=$taskId;attemptId=$attemptId;
            fence=7;deadlineAt=$deadline;authorityPath=$authority} | ConvertTo-Json -Compress))
        $process=[Diagnostics.Process]::new(); $started=$false
        try {
            $process.StartInfo.FileName=$target
            $process.StartInfo.Arguments='"'+$settingsPath+'" Save3 "'+$marker+'" '+$(if ($mode -ceq 'replayed') {'2'} else {'1'})
            $process.StartInfo.UseShellExecute=$false; $process.StartInfo.CreateNoWindow=$true
            $process.StartInfo.RedirectStandardInput=$true
            $process.StartInfo.RedirectStandardOutput=$true
            $process.StartInfo.RedirectStandardError=$true
            if (-not $process.Start()) { throw 'Inert effect child did not start.' }
            $started=$true
            $firstReply=$null
            $rounds=1; if ($mode -ceq 'replayed') { $rounds=2 }
            for ($round=0; $round -lt $rounds; $round++) {
                $pending=$process.StandardOutput.ReadLineAsync()
                if (-not $pending.Wait(5000)) { throw 'Inert effect request did not arrive.' }
                $request=$pending.Result | ConvertFrom-Json
                if ($request.action -cne 'check' -or $request.effect -cne 'Save3' -or
                    $request.taskId -cne $taskId -or $request.attemptId -cne $attemptId -or
                    $request.fence -ne 7 -or $request.index -ne ($round+1)) {
                    throw 'Inert child request differs.'
                }
                if ($mode -ceq 'parent_closed') { $process.StandardInput.Close(); break }
                $reply=[pscustomobject]@{schema=$request.schema;action='release';taskId=$taskId;
                    attemptId=$attemptId;fence=7;deadlineAt=$deadline;
                    launchId=[Guid]::NewGuid().ToString();pid=$request.pid;
                    creationTicks=$request.creationTicks;nonce=$request.nonce;index=$request.index;
                    effect=$request.effect;leaseExpiresAt=$lease;revision=0}
                if ($mode -ceq 'wrong_nonce') { $reply.nonce=[Guid]::NewGuid().ToString() }
                if ($mode -ceq 'revoked') { [IO.File]::WriteAllText($authority+'.revoked','revoked') }
                if ($mode -ceq 'replayed' -and $round -eq 1) { $reply=$firstReply }
                if ($mode -ceq 'oversized') { $process.StandardInput.WriteLine(('x'*5000)) }
                else {
                    $firstReply=$reply
                    $process.StandardInput.WriteLine(($reply | ConvertTo-Json -Compress))
                }
                $process.StandardInput.Flush()
            }
            if (-not $process.WaitForExit(8000)) { throw 'Inert effect child did not exit within bound.' }
            $expected=($mode -ceq 'valid')
            if ($expected -ne [IO.File]::Exists($marker) -or
                ($expected -and $process.ExitCode -ne 0) -or
                (-not $expected -and $process.ExitCode -eq 0)) {
                throw ('Inert effect outcome differs: '+$mode)
            }
            $checks++
        } finally {
            if ($started -and -not $process.HasExited) { $process.Kill(); $null=$process.WaitForExit(5000) }
            $process.Dispose()
        }
    }
    [pscustomobject]@{schema='overdrafter.native-effect-authority-test.v1';passed=$true;
        cases=$checks;nativeActions=0;network=$false;credentials=$false} | ConvertTo-Json -Compress
} finally { if ([IO.Directory]::Exists($root)) { [IO.Directory]::Delete($root,$true) } }
