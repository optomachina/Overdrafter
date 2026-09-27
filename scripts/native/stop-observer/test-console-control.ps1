#requires -Version 5.1
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'Observer.ps1')
Assert-CompanionWindows
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
try { $sid=$identity.User } finally { $identity.Dispose() }
$temporary=[IO.Path]::GetTempPath(); if ($env:RUNNER_TEMP) { $temporary=$env:RUNNER_TEMP }
$directory=Join-Path $temporary ('ovd574-console-control-'+[Guid]::NewGuid().ToString())
$info=New-Object IO.DirectoryInfo($directory); $info.Create((New-CompanionAcl $sid $true))
$scriptPath=Join-Path $PSScriptRoot 'fixture-marker-only.ps1'
$bytes=[IO.File]::ReadAllBytes($scriptPath)
if (@($bytes | Where-Object { $_ -gt 127 }).Count -ne 0) { throw 'Marker fixture must contain only ASCII bytes.' }
$tokens=$null; $parseErrors=$null
$null=[Management.Automation.Language.Parser]::ParseFile($scriptPath,[ref]$tokens,[ref]$parseErrors)
if ($parseErrors) { throw 'Marker fixture parse failed.' }
$probe=Join-Path $directory 'write-probe.txt'; [IO.File]::WriteAllText($probe,'fixture-write-probe')
if ([IO.File]::ReadAllText($probe) -cne 'fixture-write-probe') { throw 'Marker directory write/read failed.' }
Add-Type -Path @((Join-Path $PSScriptRoot 'DetachedProcess.cs'),(Join-Path $PSScriptRoot 'JobBoundary.cs'))
$binding=[pscustomobject]@{organizationId=[Guid]::NewGuid().ToString();projectId=[Guid]::NewGuid().ToString();workerId=[Guid]::NewGuid().ToString();
    installationId=[Guid]::NewGuid().ToString();bootId=[Guid]::NewGuid().ToString();taskId=[Guid]::NewGuid().ToString();attemptId=[Guid]::NewGuid().ToString();
    jobId=[Guid]::NewGuid().ToString();fence=1;jobSha256=('c'*64);runtimeAdmissionId=[Guid]::NewGuid().ToString()}
$request=[pscustomobject]@{binding=$binding;contextSha256=('d'*64);deadline=(Format-StopTime ([DateTimeOffset]::UtcNow.AddSeconds(60)));observerRunId=[Guid]::NewGuid().ToString()}
$requestPath=Join-Path $directory 'request.json'; [IO.File]::WriteAllText($requestPath,(ConvertTo-JournalJson $request))
$executable=Join-Path $PSHOME 'powershell.exe'; $marker=Join-Path $directory 'marker-only.entered'
$send=New-Object IO.Pipes.AnonymousPipeServerStream([IO.Pipes.PipeDirection]::Out,[IO.HandleInheritability]::Inheritable)
$receive=New-Object IO.Pipes.AnonymousPipeServerStream([IO.Pipes.PipeDirection]::In,[IO.HandleInheritability]::Inheritable)
try {
    # Reuse exact argument values, authority handles and marker path for both runs.
    # Keep the local client copies until B performs its normal suspended transfer.
    $arguments=@('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',$scriptPath,'-RequestPath',$requestPath,'-CaseDirectory',$directory,'-ReadHandle',$send.GetClientHandleAsString(),'-WriteHandle',$receive.GetClientHandleAsString())
    $argumentText=(@($arguments | ForEach-Object { '"'+$_+'"' }) -join ' ')
    $command='"'+$executable+'" '+$argumentText
    $preflight=[pscustomobject]@{authoritative=$false;encoding='ASCII';fixtureSha256=(Get-FileHash $scriptPath -Algorithm SHA256).Hash.ToLowerInvariant();
        fixtureText=[IO.File]::ReadAllText($scriptPath);writeProbePassed=$true;commandLine=$command;environment='inherited unchanged; no overrides';workingDirectory=$directory}
    [IO.File]::WriteAllText((Join-Path $directory 'preflight.json'),(ConvertTo-JournalJson $preflight))
    $process=New-Object Diagnostics.Process
    $process.StartInfo.FileName=$executable; $process.StartInfo.Arguments=$argumentText; $process.StartInfo.WorkingDirectory=$directory
    $process.StartInfo.UseShellExecute=$false; $process.StartInfo.CreateNoWindow=$true
    $process.StartInfo.RedirectStandardInput=$true; $process.StartInfo.RedirectStandardOutput=$true; $process.StartInfo.RedirectStandardError=$true
    $timer=[Diagnostics.Stopwatch]::StartNew()
    try {
        if (-not $process.Start()) { throw 'Standard control start returned false.' }
        $process.StandardInput.Close()
        $stdout=$process.StandardOutput.ReadToEndAsync(); $stderr=$process.StandardError.ReadToEndAsync()
        $retainedIdentity=Get-RunnerProcessIdentity $process $executable
        if (-not $process.WaitForExit(15000)) { throw 'Standard control deadline expired.' }
        if (-not $stdout.Wait(5000) -or -not $stderr.Wait(5000)) { throw 'Standard control capture incomplete.' }
        $runtimeCommand=$null; if ([IO.File]::Exists($marker)) { $runtimeCommand=[IO.File]::ReadAllText($marker) }
        $standard=[pscustomobject]@{authoritative=$false;launch='standard Diagnostics.Process';commandLine=$command;runtimeCommandLine=$runtimeCommand;identity=$retainedIdentity;
            entryMarker=[IO.File]::Exists($marker);exitCodeSigned=[int]$process.ExitCode;exitCodeHex=('0x'+$process.ExitCode.ToString('X8'));
            capturedAt=(Format-StopTime (Get-StopNow));elapsedMilliseconds=$timer.ElapsedMilliseconds;stdout=$stdout.Result;stderr=$stderr.Result}
        [IO.File]::WriteAllText((Join-Path $directory 'standard.json'),(ConvertTo-JournalJson $standard))
        if ([IO.File]::Exists($marker)) { [IO.File]::Move($marker,(Join-Path $directory 'standard.entered')) }
    } finally {
        if (-not $process.HasExited) { $process.Kill(); $null=$process.WaitForExit(5000) }
        $process.Dispose()
    }
    # Preserve production observation and stdin-close timing. Capture only inert
    # diagnostics after the original boundary has completed, before journal read.
    $script:controlTerminal=$null
    $script:originalBoundary=(Get-Item Function:Wait-StopBoundary).ScriptBlock
    function Wait-StopBoundary($State) {
        $counts=& $script:originalBoundary $State
        $script:controlTerminal=[pscustomobject]@{root=$State.entries[$State.job.RootPid].value;
            commandLine=$State.job.LaunchCommandLine;totalProcesses=[long]$counts.Total;activeProcesses=[long]$counts.Active;
            limitedProcesses=[long]$counts.Limited;elapsedMilliseconds=$State.clock.ElapsedMilliseconds}
        return $counts
    }
    function Start-StopOutputDrain($Process) {
        $script:controlStdout=$Process.StandardOutput.ReadToEndAsync()
        $script:controlStderr=$Process.StandardError.ReadToEndAsync()
    }
    $observerError=$null
    try {
        $null=Invoke-IndependentStopObserver -Request $request -Executable $executable -Arguments $arguments -WorkingDirectory $directory `
            -OutputDirectory (Join-Path $directory 'evidence') -AuthorityChannels @($send,$receive) -EnableObserver
    } catch { $observerError=$_.ToString() }
    if ($null -eq $script:controlTerminal) { throw ('Observer diagnostic terminal missing: '+$observerError) }
    if (-not $script:controlStdout.Wait(1000) -or -not $script:controlStderr.Wait(1000)) { throw 'Observer diagnostic capture incomplete.' }
    $runtimeCommand=$null; if ([IO.File]::Exists($marker)) { $runtimeCommand=[IO.File]::ReadAllText($marker) }
    $observed=[pscustomobject]@{authoritative=$false;launch='unchanged independent observer';terminal=$script:controlTerminal;runtimeCommandLine=$runtimeCommand;
        entryMarker=[IO.File]::Exists($marker);exitCodeSigned=[int]$script:controlTerminal.root.exitCode;
        exitCodeHex=('0x'+([int]$script:controlTerminal.root.exitCode).ToString('X8'));capturedAt=(Format-StopTime (Get-StopNow));
        stdout=$script:controlStdout.Result;stderr=$script:controlStderr.Result;observerError=$observerError}
    [IO.File]::WriteAllText((Join-Path $directory 'observer.json'),(ConvertTo-JournalJson $observed))
    if ($command -cne $script:controlTerminal.commandLine) { throw 'Paired diagnostic command differs.' }
    if ([IO.File]::Exists((Join-Path $directory 'evidence/manifest.json'))) { throw 'Marker-only control unexpectedly produced a certificate.' }
    [pscustomobject]@{diagnosticComplete=$true;authoritative=$false;standardEntered=$standard.entryMarker;observerEntered=$observed.entryMarker;evidence=$directory} | ConvertTo-Json -Compress
} finally { $send.Dispose(); $receive.Dispose() }
# This temporary workflow is diagnostic, never a substitute for source acceptance.
throw 'Paired console diagnostic complete; original source acceptance remains blocked.'
