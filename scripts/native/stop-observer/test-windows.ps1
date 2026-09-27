#requires -Version 5.1
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'Observer.ps1')
Assert-CompanionWindows
& (Join-Path $PSScriptRoot 'test-authority-channels.ps1')
Add-Type -Path (Join-Path $PSScriptRoot 'FixturePipeEvidence.cs')
$script:checks=0
function Check($Value,$Label) { $script:checks++; if (-not $Value) { throw ('Failed: '+$Label) } }
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
try { $sid=$identity.User } finally { $identity.Dispose() }
$temporary=[IO.Path]::GetTempPath(); if ($env:RUNNER_TEMP) { $temporary=$env:RUNNER_TEMP }; $root=Join-Path $temporary ('ovd574-'+[Guid]::NewGuid().ToString())
$directory=New-Object IO.DirectoryInfo($root); $directory.Create((New-CompanionAcl $sid $true))
# Pinned source assembly built before any observed process. Roots load this DLL
# without invoking a compiler inside their process envelope.
Add-Type -Path @((Join-Path $PSScriptRoot 'DetachedProcess.cs'),(Join-Path $PSScriptRoot 'JobBoundary.cs')) -OutputAssembly (Join-Path $root 'DetachedLauncher.dll')
$null=[Reflection.Assembly]::LoadFrom((Join-Path $root 'DetachedLauncher.dll'))

# The prepared host executes the actual installed Windows PowerShell engine.
$preparedHost=Join-Path $root 'PreparedPowerShellHost.exe'
Add-Type -Path (Join-Path $PSScriptRoot 'PreparedPowerShellHost.cs') -ReferencedAssemblies @('System.dll','System.Core.dll',[Management.Automation.PowerShell].Assembly.Location) -OutputAssembly $preparedHost -OutputType WindowsApplication
& (Join-Path $PSScriptRoot 'test-prepared-host.ps1') -HostExecutable $preparedHost -CaseRoot $root
$preparedScript=Join-Path $PSScriptRoot 'fixture-console-runner.ps1'
$preparedHash=(Get-FileHash -LiteralPath $preparedScript -Algorithm SHA256).Hash.ToLowerInvariant()

# A distinct, already-installed standalone compiler profile. Discovery occurs
# outside observation; no installation, legacy fallback or compiler-server use.
$vswhere=Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
$compilerCandidates=@(& $vswhere -latest -products '*' -requires Microsoft.Component.MSBuild -find 'MSBuild\Current\Bin\Roslyn\csc.exe')
if ($LASTEXITCODE -ne 0 -or $compilerCandidates.Count -ne 1 -or -not [IO.File]::Exists($compilerCandidates[0])) { throw 'One installed standalone Roslyn compiler is required; no fallback.' }
$compilerPath=[IO.Path]::GetFullPath($compilerCandidates[0]); $compilerSha256=(Get-FileHash -LiteralPath $compilerPath -Algorithm SHA256).Hash.ToLowerInvariant()
$compilerFiles=@(Get-ChildItem -LiteralPath ([IO.Path]::GetDirectoryName($compilerPath)) -File | Sort-Object Name | ForEach-Object {
    [pscustomobject]@{name=$_.Name;sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()}
})
$compilerProfile=[pscustomobject]@{profile='standalone-roslyn-noconfig-v1';path=$compilerPath;sha256=$compilerSha256;
    version=[Diagnostics.FileVersionInfo]::GetVersionInfo($compilerPath).ProductVersion;files=$compilerFiles;sharedCompilation=$false}
[IO.File]::WriteAllText((Join-Path $root 'compiler-profile.json'),($compilerProfile | ConvertTo-Json -Depth 6))

# Compile fixture code outside the job. ConsoleHost's conhost.exe is deliberately
# not allowlisted; the non-console fixture avoids that out-of-envelope process.
$fixtureRoot=Join-Path $root 'FixtureRunner.exe'
Add-Type -Path (Join-Path $PSScriptRoot 'FixtureRunner.cs') -ReferencedAssemblies @('System.dll','System.Core.dll',[Management.Automation.PowerShell].Assembly.Location) -OutputAssembly $fixtureRoot -OutputType WindowsApplication
Add-Type -Path (Join-Path $PSScriptRoot 'FixtureSleep.cs') -OutputAssembly (Join-Path $root 'FixtureSleep.exe') -OutputType WindowsApplication

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
        $result=Invoke-IndependentStopObserver -Request $case.request -Executable $fixtureRoot `
            -Arguments @((Join-Path $PSScriptRoot 'fixture-runner.ps1'),$case.path,$case.directory,$scenario) `
            -WorkingDirectory $case.directory -OutputDirectory (Join-Path $case.directory 'evidence') -EnableObserver
    } catch { $failed=$true; $errorText=$_.ToString(); [IO.File]::WriteAllText((Join-Path $case.directory 'observer-error.txt'),($_ | Format-List * -Force | Out-String)) }
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
# Actual console-shaped integration: PowerShell root, csc compiler, three console
# roles, inherited root-only authority pipes and redirected helper stdin/out/err.
# Test-only capture of fixed inert root startup diagnostics. Production drains
# to Stream.Null; no worker-controlled output is retained in evidence.
function Start-StopOutputDrain($Process) {
    $script:rootStdout=$Process.StandardOutput.ReadToEndAsync()
    $script:rootStderr=$Process.StandardError.ReadToEndAsync()
}
# Observation-only diagnostic wrapper. Preserve the original boundary loop and
# write its already captured terminal result before the caller reads the journal.
# Exact command contains only fixed inert fixture paths and decimal pipe handles.
$script:observeStopBoundary=(Get-Item Function:Wait-StopBoundary).ScriptBlock
function Wait-StopBoundary($State) {
    try { $counts=& $script:observeStopBoundary $State }
    catch {
        $originalFailure=$_
        # Diagnostic count proves an extra actual lifetime even when the
        # observer denies before the native command can write its marker.
        try {
            $script:failedJobTotal=[long]$State.job.ReadCounts().Total
            [IO.File]::WriteAllText((Join-Path $case.directory 'failed-job-total.diagnostic.txt'),[string]$script:failedJobTotal)
        } catch { Write-Warning 'Failed-boundary count diagnostic unavailable.' }
        throw $originalFailure
    }
    try {
        $rootEntry=$State.entries[$State.job.RootPid].value
        foreach ($count in @($counts.Total,$counts.Active,$counts.Limited)) {
            if ([uint64]$count -gt [int]::MaxValue) { throw 'Job count outside diagnostic Int32 range.' }
        }
        $diagnostic=[pscustomobject]@{schema='overdrafter.inert-root-diagnostic.v1';authoritative=$false;
            root=$rootEntry;exitCodeSigned=[int]$rootEntry.exitCode;
            exitCodeHex=('0x'+([int]$rootEntry.exitCode).ToString('X8'));
            capturedAt=(Format-StopTime (Get-StopNow));elapsedMilliseconds=$State.clock.ElapsedMilliseconds;
            totalProcesses=[int]$counts.Total;activeProcesses=[int]$counts.Active;limitedProcesses=[int]$counts.Limited;
            sanitizedInertCommandLine=$State.job.LaunchCommandLine}
        [IO.File]::WriteAllText((Join-Path $case.directory 'root-terminal.diagnostic.json'),(ConvertTo-JournalJson $diagnostic))
    } catch { Write-Warning ('Inconclusive diagnostic: terminal record write failed: '+$_.Exception.Message) }
    return $counts
}
foreach ($consoleScenario in @('console','engine_unknown_native')) {
$case=New-Case $consoleScenario; $script:skipUntilExit=$false; $script:failedJobTotal=0; $script:rootStdout=$null; $script:rootStderr=$null
$send=New-Object IO.Pipes.AnonymousPipeServerStream([IO.Pipes.PipeDirection]::Out,[IO.HandleInheritability]::Inheritable)
$receive=New-Object IO.Pipes.AnonymousPipeServerStream([IO.Pipes.PipeDirection]::In,[IO.HandleInheritability]::Inheritable)
try {
    $writer=New-Object IO.StreamWriter($send); $writer.AutoFlush=$true; $writer.WriteLine('fixture-authority')
    $reader=New-Object IO.StreamReader($receive); $reply=[FixturePipeReceipt]::Read($reader,(Join-Path $case.directory 'authority-eof-release'))
    $readHandle=$send.GetClientHandleAsString(); $writeHandle=$receive.GetClientHandleAsString()
    $launchArguments=@($preparedScript,$preparedHash,'-RequestPath',$case.path,'-CaseDirectory',$case.directory,'-ReadHandle',$readHandle,'-WriteHandle',$writeHandle,'-CompilerPath',$compilerPath,'-CompilerSha256',$compilerSha256)
    if ($consoleScenario -eq 'engine_unknown_native') { $launchArguments+='+UnjournaledNative' }
    $failure=$null
    try {
        $result=Invoke-IndependentStopObserver -Request $case.request -Executable $preparedHost `
            -Arguments $launchArguments -WorkingDirectory $case.directory -OutputDirectory (Join-Path $case.directory 'evidence') -AuthorityChannels @($send,$receive) -EnableObserver
    } catch { $failure=$_; [IO.File]::WriteAllText((Join-Path $case.directory 'observer-error.txt'),($_ | Format-List * -Force | Out-String)) }
    if ($consoleScenario -eq 'engine_unknown_native') {
        $prior=Read-NativeJournalText ([IO.File]::ReadAllText((Join-Path $case.directory 'pre-unknown-journal.json')))
        $summary=Get-NativeJournalSummary $prior
        $roles=@($prior.records | Where-Object { $_.kind -ceq 'launch_intent' } | ForEach-Object { $_.data.role } | Sort-Object)
        Check ($summary.launches -eq 4 -and $summary.recordedProcessesExited -and ($roles -join ',') -ceq 'compiler,lifecycle,native,operation' -and
            (ConvertTo-JournalJson $prior.binding) -ceq (ConvertTo-JournalJson $case.request.binding)) 'unknown-launch case already has exact otherwise-complete four-role journal'
        $specific=$null -ne $failure -and $failure.ToString() -match 'Missed process or terminal observation|Unknown descendant|Independent parent observation missing|Missed or unknown job process|Journal binding, launch gap or terminal set differs'
        Check $specific 'actual engine unjournaled native invocation denied by independent accounting'
        Check (($script:failedJobTotal -gt 5) -or [IO.File]::Exists((Join-Path $case.directory 'unjournaled-native.txt'))) 'actual extra native lifetime or side effect observed'
        Check (-not [IO.File]::Exists((Join-Path $case.directory 'evidence/manifest.json'))) 'unjournaled engine launch cannot certify'
    } else {
        if ($null -ne $failure) { throw $failure }
        Check ($reply.Wait(1000) -and $reply.Result.Text.Trim() -ceq 'fixture-authority-ack') 'exact inherited authority pipe exchange'
        $manifest=ConvertFrom-CompanionJson ([IO.File]::ReadAllText($result.manifestPath))
        Check ([IO.File]::Exists((Join-Path $case.directory 'authority-eof-release'))) 'authority EOF releases blocked live helper; inherited writer would deny'
        Check ($manifest.totalProcesses -eq 5 -and $manifest.terminalProcesses.Count -eq 4 -and $manifest.executionOutcome -ceq 'native_exit_succeeded') 'actual console root compiler native lifecycle operation closure'
    }
} finally {
    if ($null -ne $script:rootStdout -and $script:rootStdout.IsCompleted) { [IO.File]::WriteAllText((Join-Path $case.directory 'root.stdout.txt'),$script:rootStdout.Result) }
    if ($null -ne $script:rootStderr -and $script:rootStderr.IsCompleted) { [IO.File]::WriteAllText((Join-Path $case.directory 'root.stderr.txt'),$script:rootStderr.Result) }
    $send.Dispose(); $receive.Dispose()
}
}
# Withhold authority bytes from a real console root. The same inherited pipe
# must remain blocked until the observer deadline closes the job; no certificate.
$case=New-Case 'console_deadline'; $case.request.deadline=Format-StopTime ([DateTimeOffset]::UtcNow.AddSeconds(5)); $script:rootStdout=$null; $script:rootStderr=$null
[IO.File]::WriteAllText($case.path,(ConvertTo-JournalJson $case.request))
$send=New-Object IO.Pipes.AnonymousPipeServerStream([IO.Pipes.PipeDirection]::Out,[IO.HandleInheritability]::Inheritable)
$receive=New-Object IO.Pipes.AnonymousPipeServerStream([IO.Pipes.PipeDirection]::In,[IO.HandleInheritability]::Inheritable)
try {
    $reader=New-Object IO.StreamReader($receive); $reply=[FixturePipeReceipt]::Read($reader,$null)
    $readHandle=$send.GetClientHandleAsString(); $writeHandle=$receive.GetClientHandleAsString(); $denied=$false
    try {
        Invoke-IndependentStopObserver -Request $case.request -Executable $preparedHost `
            -Arguments @($preparedScript,$preparedHash,'-RequestPath',$case.path,'-CaseDirectory',$case.directory,'-ReadHandle',$readHandle,'-WriteHandle',$writeHandle,'-CompilerPath',$compilerPath,'-CompilerSha256',$compilerSha256) `
            -WorkingDirectory $case.directory -OutputDirectory (Join-Path $case.directory 'evidence') -AuthorityChannels @($send,$receive) -EnableObserver | Out-Null
    } catch { $denied=$_.ToString() -match 'deadline expired' }
    Check ($denied -and [IO.File]::Exists((Join-Path $case.directory 'console-ready'))) 'deadline denies actually blocked inherited-pipe root'
    try { $closed=$reply.Wait(5000) }
    catch {
        $errors=@($reply.Exception.Flatten().InnerExceptions | ForEach-Object {
            [pscustomobject]@{type=$_.GetType().FullName;hresult=$_.HResult;message=$_.Message;detail=$_.ToString()}
        })
        [IO.File]::WriteAllText((Join-Path $case.directory 'pipe-closure-error.diagnostic.json'),($errors | ConvertTo-Json -Depth 5))
        throw
    }
    Check ($closed -and $reply.Result.Text -ceq '') 'root loss yields authority EOF without retained local copies'
    Check (-not [IO.File]::Exists((Join-Path $case.directory 'evidence/manifest.json'))) 'late evidence never published'
} finally {
    if ($null -ne $script:rootStdout -and $script:rootStdout.IsCompleted) { [IO.File]::WriteAllText((Join-Path $case.directory 'root.stdout.txt'),$script:rootStdout.Result) }
    if ($null -ne $script:rootStderr -and $script:rootStderr.IsCompleted) { [IO.File]::WriteAllText((Join-Path $case.directory 'root.stderr.txt'),$script:rootStderr.Result) }
    $send.Dispose(); $receive.Dispose()
}
# Exercise existing cleanup through the new factory, using actual retained
# detached handles. Timeout/callback failure cannot leave a reusable result.
. (Join-Path $PSScriptRoot '../file-admission/OwnedProcess.ps1')
$factory={ New-Object OverDrafter.StopObserver.DetachedProcess }
$slow=Invoke-OwnedProcess (Join-Path $root 'FixtureSleep.exe') @('5000') 100 (Join-Path $root 'timeout') -ProcessFactory $factory
Check ($slow.timedOut -and $slow.terminated -and $null -ne $slow.exitCode) 'detached timeout observes its exact terminated child'
$badCapture=Invoke-OwnedProcess (Join-Path $root 'FixtureSleep.exe') @('5000') 10000 (Join-Path $root 'callback') -ProcessFactory $factory -CaptureFactory { throw 'fixture capture failure' }
Check ($badCapture.terminated -and $badCapture.error -match 'fixture capture failure' -and $null -ne $badCapture.exitCode) 'detached callback failure retains cleanup evidence'
# Kill a real independent observer after its inert worker starts. The job closes
# with the observer, but even confirmed cleanup must never create a certificate.
$case=New-Case 'observer_loss'; $hostProcess=New-Object Diagnostics.Process
$hostProcess.StartInfo.FileName=Join-Path $PSHOME 'powershell.exe'
$launchArguments=@('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',(Join-Path $PSScriptRoot 'fixture-observer-host.ps1'),'-RequestPath',$case.path,'-CaseDirectory',$case.directory)
$hostProcess.StartInfo.Arguments=(@($launchArguments | ForEach-Object { '"'+$_+'"' }) -join ' ')
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
    nativeActions=0;processes='real PowerShell5.1 engine, compiler and inert console helpers';evidenceRoot=$root} | ConvertTo-Json -Compress
