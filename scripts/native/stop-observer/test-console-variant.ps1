#requires -Version 5.1
param([ValidateSet('baseline','stdin_open','no_window')][string]$Variant,[switch]$CaptureObservedIdentities)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'Observer.ps1')
Assert-CompanionWindows
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
try { $sid=$identity.User } finally { $identity.Dispose() }
$temporary=[IO.Path]::GetTempPath(); if ($env:RUNNER_TEMP) { $temporary=$env:RUNNER_TEMP }
$directory=Join-Path $temporary ('ovd574-variant-'+$Variant+'-'+[Guid]::NewGuid().ToString())
$info=New-Object IO.DirectoryInfo($directory); $info.Create((New-CompanionAcl $sid $true))
$markerScript=Join-Path $PSScriptRoot 'fixture-marker-only.ps1'; $marker=Join-Path $directory 'marker-only.entered'
$bytes=[IO.File]::ReadAllBytes($markerScript)
if (@($bytes | Where-Object { $_ -gt 127 }).Count -ne 0) { throw 'Marker fixture encoding differs.' }
$tokens=$null; $parseErrors=$null
$null=[Management.Automation.Language.Parser]::ParseFile($markerScript,[ref]$tokens,[ref]$parseErrors)
if ($parseErrors) { throw 'Marker fixture parse failed.' }
$probe=Join-Path $directory 'write-probe.txt'; [IO.File]::WriteAllText($probe,'fixture-write-probe')
if ([IO.File]::ReadAllText($probe) -cne 'fixture-write-probe') { throw 'Marker directory write/read failed.' }
# Fresh shell per mode. Compile an artifact copy; never edit the source launcher.
$nativeText=[IO.File]::ReadAllText((Join-Path $PSScriptRoot 'DetachedProcess.cs'))
$flags='0x0008000c'
if ($Variant -eq 'no_window') {
    if ([regex]::Matches($nativeText,'0x0008000c').Count -ne 1) { throw 'Console-mode diagnostic target differs.' }
    $nativeText=$nativeText.Replace('0x0008000c','0x08080004'); $flags='0x08080004'
}
$launcherPath=Join-Path $directory 'DetachedProcess.cs'; [IO.File]::WriteAllText($launcherPath,$nativeText)
Add-Type -Path @($launcherPath,(Join-Path $PSScriptRoot 'JobBoundary.cs'))
if ($Variant -eq 'stdin_open') {
    $definition=(Get-Item Function:Invoke-IndependentStopObserver).Definition
    $needle='$state.job.RootProcess.StandardInput.Close()'
    if ([regex]::Matches($definition,[regex]::Escape($needle)).Count -ne 1) { throw 'Stdin diagnostic target differs.' }
    $definition=$definition.Replace($needle,'# Diagnostic only: retain stdin writer until bounded root exit or cleanup.')
    Set-Item Function:Invoke-IndependentStopObserver ([scriptblock]::Create($definition))
}
# Reuse values already obtained from the held process handle. These are receipt
# events, not guaranteed creation notifications or an accounting alternative.
$script:identityEvents=New-Object 'System.Collections.Generic.List[object]'
$script:identityEventsOverflow=$false
if ($CaptureObservedIdentities) {
    if ($Variant -ne 'no_window') { throw 'Identity diagnostic is scoped to no_window only.' }
    $definition=(Get-Item Function:Read-StopProcess).Definition
    $identityLine='$identity=Get-RunnerProcessIdentity ([pscustomobject]@{Handle=$Handle}) $path'
    $parentLine='$parent=Get-StopParent $identity.pid'
    foreach ($target in @($identityLine,$parentLine)) {
        if ([regex]::Matches($definition,[regex]::Escape($target)).Count -ne 1) { throw 'Identity diagnostic target differs.' }
    }
    $receipt=@'
$identity=Get-RunnerProcessIdentity ([pscustomobject]@{Handle=$Handle}) $path
    $diagnosticEvent=[pscustomobject]@{message='retained_process_identity_observed';isRoot=$Root;
        monotonicReceiptTicks=[Diagnostics.Stopwatch]::GetTimestamp();elapsedMilliseconds=$State.clock.ElapsedMilliseconds;
        identity=$identity;image=$path;parentLookupAttempted=$false;parentPid=$null;parentLookupError=$null}
    if ($script:identityEvents.Count -lt 129) { $script:identityEvents.Add($diagnosticEvent) }
    else { $script:identityEventsOverflow=$true }
'@
    $parentReceipt=@'
$diagnosticEvent.parentLookupAttempted=$true
        try { $parent=Get-StopParent $identity.pid; $diagnosticEvent.parentPid=$parent }
        catch { $diagnosticEvent.parentLookupError=$_.ToString(); throw }
'@
    $definition=$definition.Replace($identityLine,$receipt).Replace($parentLine,$parentReceipt)
    Set-Item Function:Read-StopProcess ([scriptblock]::Create($definition))
}
$binding=[pscustomobject]@{organizationId=[Guid]::NewGuid().ToString();projectId=[Guid]::NewGuid().ToString();workerId=[Guid]::NewGuid().ToString();
    installationId=[Guid]::NewGuid().ToString();bootId=[Guid]::NewGuid().ToString();taskId=[Guid]::NewGuid().ToString();attemptId=[Guid]::NewGuid().ToString();
    jobId=[Guid]::NewGuid().ToString();fence=1;jobSha256=('c'*64);runtimeAdmissionId=[Guid]::NewGuid().ToString()}
$request=[pscustomobject]@{binding=$binding;contextSha256=('d'*64);deadline=(Format-StopTime ([DateTimeOffset]::UtcNow.AddSeconds(60)));observerRunId=[Guid]::NewGuid().ToString()}
$requestPath=Join-Path $directory 'request.json'; [IO.File]::WriteAllText($requestPath,(ConvertTo-JournalJson $request))
$script:variantObservation=$null; $script:variantCleanup=$null
$script:originalBoundary=(Get-Item Function:Wait-StopBoundary).ScriptBlock
function Wait-StopBoundary($State) {
    try { return & $script:originalBoundary $State }
    finally {
        # Preserve denial evidence before normal observer disposal kills its job.
        # Any forced cleanup below is separately labelled, never terminal proof.
        $queryErrors=New-Object 'System.Collections.Generic.List[string]'
        $total=$null; $active=$null; $limited=$null; $pids=$null
        try {
            $counts=$State.job.ReadCounts(); $total=[long]$counts.Total; $active=[long]$counts.Active; $limited=[long]$counts.Limited
        } catch { $queryErrors.Add('Counts: '+$_.Exception.Message) }
        try { $pids=@($State.job.ReadPids()) } catch { $queryErrors.Add('Pids: '+$_.Exception.Message) }
        $script:variantObservation=[pscustomobject]@{root=$State.entries[$State.job.RootPid].value;
            processes=@($State.entries.Values | ForEach-Object { $_.value });currentJobPids=$pids;
            commandLine=$State.job.LaunchCommandLine;totalProcesses=$total;activeProcesses=$active;
            limitedProcesses=$limited;rootClosed=$State.rootClosed;elapsedMilliseconds=$State.clock.ElapsedMilliseconds;
            diagnosticQueryComplete=($queryErrors.Count -eq 0);diagnosticQueryErrors=$queryErrors.ToArray()}
        if (-not $State.rootClosed) {
            $script:variantCleanup=[pscustomobject]@{forced=$false;exitCodeSigned=$null;exitCodeHex=$null;observedAt=$null;error=$null}
            try {
                $owned=$State.job.RootProcess
                if (-not $owned.HasExited) { $owned.Kill(); $script:variantCleanup.forced=$true }
                if (-not $owned.WaitForExit(5000)) { throw 'Diagnostic owned root cleanup remains unknown.' }
                $script:variantCleanup.exitCodeSigned=[int]$owned.ExitCode
                $script:variantCleanup.exitCodeHex='0x'+$owned.ExitCode.ToString('X8')
                $script:variantCleanup.observedAt=Format-StopTime (Get-StopNow)
            } catch { $script:variantCleanup.error=$_.Exception.Message }
        }
    }
}
function Start-StopOutputDrain($Process) {
    $script:variantStdout=$Process.StandardOutput.ReadToEndAsync()
    $script:variantStderr=$Process.StandardError.ReadToEndAsync()
}
$send=New-Object IO.Pipes.AnonymousPipeServerStream([IO.Pipes.PipeDirection]::Out,[IO.HandleInheritability]::Inheritable)
$receive=New-Object IO.Pipes.AnonymousPipeServerStream([IO.Pipes.PipeDirection]::In,[IO.HandleInheritability]::Inheritable)
try {
    $arguments=@('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',$markerScript,'-RequestPath',$requestPath,'-CaseDirectory',$directory,'-ReadHandle',$send.GetClientHandleAsString(),'-WriteHandle',$receive.GetClientHandleAsString())
    $preflight=[pscustomobject]@{authoritative=$false;variant=$Variant;creationFlags=$flags;encoding='ASCII';writeProbePassed=$true;
        fixtureSha256=(Get-FileHash $markerScript -Algorithm SHA256).Hash.ToLowerInvariant();fixtureText=[IO.File]::ReadAllText($markerScript);
        launcherSha256=(Get-FileHash $launcherPath -Algorithm SHA256).Hash.ToLowerInvariant();environment='inherited; no overrides';deadline=$request.deadline}
    [IO.File]::WriteAllText((Join-Path $directory 'preflight.json'),(ConvertTo-JournalJson $preflight))
    $observerError=$null
    try {
        $null=Invoke-IndependentStopObserver -Request $request -Executable (Join-Path $PSHOME 'powershell.exe') -Arguments $arguments `
            -WorkingDirectory $directory -OutputDirectory (Join-Path $directory 'evidence') -AuthorityChannels @($send,$receive) -EnableObserver
    } catch { $observerError=$_.ToString() }
    if ($null -eq $script:variantObservation) { throw ('Variant diagnostic observation missing: '+$observerError) }
    if (-not $script:variantStdout.Wait(5000) -or -not $script:variantStderr.Wait(5000)) { throw 'Variant capture incomplete.' }
    $runtimeCommand=$null; if ([IO.File]::Exists($marker)) { $runtimeCommand=[IO.File]::ReadAllText($marker) }
    $exitCode=$script:variantObservation.root.exitCode; $hexCode=$null
    if ($null -ne $exitCode) { $hexCode='0x'+([int]$exitCode).ToString('X8') }
    $result=[pscustomobject]@{authoritative=$false;variant=$Variant;creationFlags=$flags;entryMarker=[IO.File]::Exists($marker);
        processObservationEvents=$script:identityEvents.ToArray();processObservationEventsOverflow=$script:identityEventsOverflow;
        runtimeCommandLine=$runtimeCommand;exitCodeSigned=$exitCode;exitCodeHex=$hexCode;observation=$script:variantObservation;
        failureCleanup=$script:variantCleanup;capturedAt=(Format-StopTime (Get-StopNow));stdout=$script:variantStdout.Result;
        stderr=$script:variantStderr.Result;observerError=$observerError}
    [IO.File]::WriteAllText((Join-Path $directory 'result.json'),(ConvertTo-JournalJson $result))
    if ([IO.File]::Exists((Join-Path $directory 'evidence/manifest.json'))) { throw 'Marker diagnostic unexpectedly produced a certificate.' }
    [pscustomobject]@{diagnosticComplete=$true;authoritative=$false;variant=$Variant;entryMarker=$result.entryMarker;exitCode=$exitCode;evidence=$directory} | ConvertTo-Json -Compress
} finally { $send.Dispose(); $receive.Dispose() }
