#requires -Version 5.1
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'Observer.ps1')
Assert-CompanionWindows
$script:checks=0
function Check($Value,$Label) { $script:checks++; if (-not $Value) { throw ('Failed: '+$Label) } }
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
try { $sid=$identity.User } finally { $identity.Dispose() }
$root=Join-Path ([IO.Path]::GetTempPath()) ('ovd574-'+[Guid]::NewGuid().ToString())
$directory=New-Object IO.DirectoryInfo($root); $directory.Create((New-CompanionAcl $sid $true))
function New-Case([string]$Scenario) {
    $dir=Join-Path $root $Scenario
    $directory=New-Object IO.DirectoryInfo($dir); $directory.Create((New-CompanionAcl $sid $true))
    $binding=[pscustomobject]@{organizationId=[Guid]::NewGuid().ToString();projectId=[Guid]::NewGuid().ToString();workerId=[Guid]::NewGuid().ToString();
        installationId=[Guid]::NewGuid().ToString();bootId=[Guid]::NewGuid().ToString();taskId=[Guid]::NewGuid().ToString();attemptId=[Guid]::NewGuid().ToString();
        jobId=[Guid]::NewGuid().ToString();fence=1;jobSha256=('c'*64);runtimeAdmissionId=[Guid]::NewGuid().ToString()}
    $request=[pscustomobject]@{binding=$binding;contextSha256=('d'*64);deadline=(Format-StopTime ([DateTimeOffset]::UtcNow.AddSeconds(60)));observerRunId=[Guid]::NewGuid().ToString()}
    $path=Join-Path $dir 'request.json'; [IO.File]::WriteAllText($path,(ConvertTo-JournalJson $request))
    return [pscustomobject]@{directory=$dir;request=$request;path=$path}
}
# Test-only seam suppresses sampling until the unjournaled child really exits.
# Counts/handles/creation/terminal/journal reads remain actual Windows operations.
function Get-StopPids($State) {
    if ($script:skipUntilExit) {
        $timer=[Diagnostics.Stopwatch]::StartNew()
        while (-not [IO.File]::Exists((Join-Path $script:missedCase 'unknown-exited')) -and $timer.ElapsedMilliseconds -lt 10000) { Start-Sleep -Milliseconds 10 }
        Check ([IO.File]::Exists((Join-Path $script:missedCase 'unknown-exited'))) 'real child exited before first sample'
        $script:skipUntilExit=$false
    }
    return $State.job.ReadPids()
}
foreach ($scenario in @('valid','unknown','missed','gap','missing_terminal')) {
    $case=New-Case $scenario; $script:skipUntilExit=$scenario -eq 'missed'; $script:missedCase=$case.directory; $failed=$false; $errorText=$null
    try {
        $result=Invoke-IndependentStopObserver -Request $case.request -Executable (Join-Path $PSHOME 'powershell.exe') `
            -Arguments @('-NoProfile','-NonInteractive','-File',(Join-Path $PSScriptRoot 'fixture-runner.ps1'),'-RequestPath',$case.path,'-CaseDirectory',$case.directory,'-Scenario',$scenario) `
            -WorkingDirectory $case.directory -OutputDirectory (Join-Path $case.directory 'evidence') -EnableObserver
    } catch { $failed=$true; $errorText=$_.ToString() }
    if ($scenario -eq 'valid') {
        if ($failed) { throw ('Valid inert observation failed: '+$errorText) }
        $text=[IO.File]::ReadAllText($result.manifestPath); $manifest=ConvertFrom-CompanionJson $text
        Check ($manifest.totalProcesses -eq 2 -and $manifest.activeProcesses -eq 0 -and $manifest.terminalProcesses.Count -eq 1) 'real job accounting and independently observed exit'
        Check ($result.sha256 -ceq (Get-JournalDigest $text) -and -not $result.stopAdmission) 'immutable canonical source certificate'
        Check ($manifest.executionOutcome -eq 'native_failed') 'compiler-only fixture cannot claim native result success'
    } else {
        Check $failed ('actual runtime denial '+$scenario)
        if ($scenario -eq 'missed') { Check ($errorText -match 'Missed process or terminal observation') 'lifetime count catches unsampled short-lived child' }
        Check (-not [IO.File]::Exists((Join-Path $case.directory 'evidence/manifest.json'))) ('no complete evidence '+$scenario)
    }
}
# Kill a real independent observer after its inert worker starts. The job closes
# with the observer, but even confirmed cleanup must never create a certificate.
$case=New-Case 'observer_loss'; $hostProcess=New-Object Diagnostics.Process
$hostProcess.StartInfo.FileName=Join-Path $PSHOME 'powershell.exe'
$args=@('-NoProfile','-NonInteractive','-File',(Join-Path $PSScriptRoot 'fixture-observer-host.ps1'),'-RequestPath',$case.path,'-CaseDirectory',$case.directory)
$hostProcess.StartInfo.Arguments=(@($args | ForEach-Object { '"'+$_+'"' }) -join ' ')
$hostProcess.StartInfo.UseShellExecute=$false; $hostProcess.StartInfo.CreateNoWindow=$true
try {
    Check ($hostProcess.Start()) 'observer host starts'
    $timer=[Diagnostics.Stopwatch]::StartNew()
    while (-not [IO.File]::Exists((Join-Path $case.directory 'root-started')) -and -not $hostProcess.HasExited -and $timer.ElapsedMilliseconds -lt 20000) { Start-Sleep -Milliseconds 50 }
    Check ([IO.File]::Exists((Join-Path $case.directory 'root-started'))) 'observer established actual suspended-root boundary'
    $hostProcess.Kill(); Check ($hostProcess.WaitForExit(10000)) 'observer failure is observed'
    Check (-not [IO.File]::Exists((Join-Path $case.directory 'evidence/manifest.json'))) 'observer loss never publishes completeness'
} finally { if (-not $hostProcess.HasExited) { $hostProcess.Kill(); $null=$hostProcess.WaitForExit(10000) }; $hostProcess.Dispose() }
[pscustomobject]@{schema='overdrafter.stop-observer-windows-tests.v1';passed=$true;assertions=$script:checks;
    nativeActions=0;processes='real inert PowerShell children';evidenceRoot=$root} | ConvertTo-Json -Compress
