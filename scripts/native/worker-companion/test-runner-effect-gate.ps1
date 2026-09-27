#requires -Version 5.1
# Inert process proves operation creation is acknowledged before a native-effect
# marker can be written, including a blocked acknowledgment across the lease.
$ErrorActionPreference='Stop'; Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot '../file-admission/OwnedProcess.ps1')
. (Join-Path $PSScriptRoot '../attempt-journal/JournalRunner.ps1')
$root=Join-Path $env:TEMP ('ovd562-runner-gate-'+[Guid]::NewGuid().ToString())
[IO.Directory]::CreateDirectory($root) | Out-Null
try {
    $compiler=Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
    $target=Join-Path $root 'NativeEffectGateHarness.exe'
    & $compiler /nologo /target:exe ('/out:'+$target) /reference:System.Web.Extensions.dll `
        (Join-Path $PSScriptRoot '../prepared-dimension/NativeEffectGate.cs') `
        (Join-Path $PSScriptRoot 'NativeEffectGateHarness.cs')
    if ($LASTEXITCODE -ne 0 -or -not [IO.File]::Exists($target)) { throw 'Runner gate harness failed to compile.' }
    # Mock only persistence/identity boundary bookkeeping. The real retained
    # Process, OwnedProcess cleanup, JournalRunner effect loop and C# gate run.
    function New-RunnerJournalLaunch($Session,[string]$Role,[string]$Executable,[string[]]$Arguments,[string]$WorkingDirectory) {
        $script:order.Add('intent')
        return [pscustomobject]@{intent=[pscustomobject]@{launchId=[Guid]::NewGuid().ToString();role=$Role};
            identity=$null;exited=$false}
    }
    function Set-RunnerJournalCreation($Session,$Launch,$Process) {
        $script:order.Add('created')
        $Launch.identity=[pscustomobject]@{launchId=$Launch.intent.launchId;pid=$Process.Id;
            creationTicks=$Process.StartTime.ToUniversalTime().Ticks.ToString();sessionId=$Process.SessionId}
    }
    function Set-RunnerJournalExit($Session,$Launch,[int]$ExitCode,[bool]$TerminationRequested) {
        $script:order.Add('exited'); $Launch.exited=$true
    }
    function Add-RunnerJournalEvent($Session,[string]$Kind,$Data) { $script:order.Add($Kind) }
    foreach ($mode in @('valid','delayed_ack')) {
        $folder=Join-Path $root $mode; [IO.Directory]::CreateDirectory($folder) | Out-Null
        $authority=Join-Path $folder 'authority.json'; $settingsPath=Join-Path $folder 'settings.json'
        $marker=Join-Path $folder 'native-marker.txt'; $log=Join-Path $folder 'child'
        $script:order=New-Object 'System.Collections.Generic.List[string]'
        $script:authorityCalls=0
        $taskId=[Guid]::NewGuid().ToString(); $attemptId=[Guid]::NewGuid().ToString()
        $deadline=[DateTimeOffset]::UtcNow.AddSeconds(20)
        $lease=[DateTimeOffset]::UtcNow.AddSeconds(15)
        if ($mode -ceq 'delayed_ack') { $deadline=[DateTimeOffset]::UtcNow.AddSeconds(8); $lease=[DateTimeOffset]::UtcNow.AddSeconds(4) }
        $deadlineText=$deadline.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
        $leaseText=$lease.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
        [IO.File]::WriteAllText($authority,([pscustomobject]@{
            schema='overdrafter.companion-task-authority.v1';attemptId=$attemptId;fence=7;
            deadlineAt=$deadlineText;leaseExpiresAt=$leaseText;revision=0} | ConvertTo-Json -Compress))
        [IO.File]::WriteAllText($settingsPath,([pscustomobject]@{
            taskId=$taskId;attemptId=$attemptId;fence=7;deadlineAt=$deadlineText;
            authorityPath=$authority} | ConvertTo-Json -Compress))
        $session=[pscustomobject]@{journal=[pscustomobject]@{binding=[pscustomobject]@{
            taskId=$taskId;attemptId=$attemptId;fence=7}}}
        $ack={param($Session,$Launch)
            $script:order.Add('ack')
            if ($mode -ceq 'delayed_ack') { Start-Sleep -Seconds 6 }
        }.GetNewClosure()
        $answer={param($request)
            $script:authorityCalls++
            if ($script:order -cnotcontains 'ack' -or $request.taskId -cne $taskId -or
                $request.attemptId -cne $attemptId -or $request.fence -ne 7 -or
                $request.effect -cne 'Save3' -or [DateTimeOffset]::UtcNow -ge $lease) {
                throw 'Inert release was requested without current acknowledgment and lease.'
            }
            $script:order.Add('authority')
            return [pscustomobject]@{schema=$request.schema;action='release';taskId=$taskId;
                attemptId=$attemptId;fence=7;deadlineAt=$deadlineText;launchId=$request.launchId;
                pid=$request.pid;creationTicks=$request.creationTicks;nonce=$request.nonce;
                index=$request.index;effect=$request.effect;leaseExpiresAt=$leaseText;revision=0}
        }.GetNewClosure()
        $remaining={ [int][Math]::Floor(($deadline-[DateTimeOffset]::UtcNow).TotalMilliseconds) }.GetNewClosure()
        $result=$null
        try {
            $result=Invoke-RunnerJournalChild $session 'operation' $target @($settingsPath,'Save3',$marker,'1') `
                12000 $log -CreationAcknowledged $ack -RemainingMs $remaining -EffectAuthority $answer
        } catch {
            if ($mode -ceq 'valid') { throw }
            $result=[pscustomobject]@{error=$_.Exception.Message;exitCode=$null}
        }
        if ($mode -ceq 'valid') {
            if ($result.exitCode -ne 0 -or $result.error -or -not [IO.File]::Exists($marker) -or
                [string]::Join(',', $script:order.ToArray()) -cne 'intent,created,ack,authority,exited' -or
                $script:authorityCalls -ne 1) { throw ('Valid runner release failed: exit='+$result.exitCode+
                    ' marker='+[IO.File]::Exists($marker)+' order='+[string]::Join(',', $script:order.ToArray())+
                    ' calls='+$script:authorityCalls+' error='+$result.error+' stderr='+$result.stderr) }
        } else {
            if ([IO.File]::Exists($marker) -or $script:authorityCalls -gt 1 -or
                $script:order[0] -cne 'intent' -or $script:order[1] -cne 'created' -or
                $script:order[2] -cne 'ack') { throw 'Delayed creation acknowledgment admitted an effect.' }
        }
    }
    [pscustomobject]@{schema='overdrafter.runner-effect-gate-test.v1';passed=$true;
        cases=2;nativeActions=0;network=$false;credentials=$false} | ConvertTo-Json -Compress
} finally { if ([IO.Directory]::Exists($root)) { [IO.Directory]::Delete($root,$true) } }
