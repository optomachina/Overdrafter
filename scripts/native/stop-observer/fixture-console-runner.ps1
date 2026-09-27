#requires -Version 5.1
param([string]$RequestPath,[string]$CaseDirectory,[string]$ReadHandle,[string]$WriteHandle)
$ErrorActionPreference='Stop'
trap { [IO.File]::WriteAllText((Join-Path $CaseDirectory 'startup-error.txt'),($_ | Format-List * -Force | Out-String)); exit 1 }
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot '../attempt-journal/JournalRunner.ps1')
. (Join-Path $PSScriptRoot '../file-admission/OwnedProcess.ps1')
$null=[Reflection.Assembly]::LoadFrom((Join-Path ([IO.Directory]::GetParent($CaseDirectory).FullName) 'DetachedLauncher.dll'))
$request=ConvertFrom-CompanionJson ([IO.File]::ReadAllText($RequestPath))
$session=New-RunnerJournal $request.binding
$native=$null; $operation=$null; $incoming=$null; $outgoing=$null
try {
    # Same explicit inherited anonymous-pipe shape as the companion authority
    # channel. Child helpers get no extra handles from DetachedProcess.Start.
    $incoming=New-Object IO.Pipes.AnonymousPipeClientStream([IO.Pipes.PipeDirection]::In,$ReadHandle)
    $outgoing=New-Object IO.Pipes.AnonymousPipeClientStream([IO.Pipes.PipeDirection]::Out,$WriteHandle)
    $reader=New-Object IO.StreamReader($incoming); $writer=New-Object IO.StreamWriter($outgoing); $writer.AutoFlush=$true
    [IO.File]::WriteAllText((Join-Path $CaseDirectory 'console-ready'),'fixture')
    $line=$reader.ReadLine()
    if ($line -cne 'fixture-authority') { throw 'Inherited authority bytes differ.' }
    $writer.WriteLine('fixture-authority-ack')
    $compiler=Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
    $helper=Join-Path $CaseDirectory 'ConsoleHelper.exe'
    $factory={ New-Object OverDrafter.StopObserver.DetachedProcess }
    $compiled=Invoke-RunnerJournalChild $session compiler $compiler @('/nologo','/target:exe',('/out:'+$helper),(Join-Path $PSScriptRoot 'FixtureConsole.cs')) 15000 (Join-Path $CaseDirectory 'compiler') -ProcessFactory $factory
    if ($compiled.exitCode -ne 0 -or $compiled.error) { throw 'Actual compiler fixture failed.' }
    $nativeLaunch=New-RunnerJournalLaunch $session native $helper @('native') $CaseDirectory
    $native=New-Object OverDrafter.StopObserver.DetachedProcess
    $native.StartInfo.FileName=$helper; $native.StartInfo.Arguments='native'; $native.StartInfo.UseShellExecute=$false
    $native.StartInfo.RedirectStandardOutput=$true; $native.StartInfo.RedirectStandardError=$true
    $null=$native.Start(); Set-RunnerJournalCreation $session $nativeLaunch $native
    $nativeOut=$native.StandardOutput.ReadToEndAsync(); $nativeError=$native.StandardError.ReadToEndAsync()
    # Native-shaped console helper remains alive for six seconds. Authority EOF
    # must be observed now, proving that this helper did not inherit either end.
    $incoming.Dispose(); $outgoing.Dispose()
    Add-RunnerJournalEvent $session phase ([pscustomobject]@{phase='startup_wait'})
    Add-RunnerJournalEvent $session phase ([pscustomobject]@{phase='startup_ready'})
    $lifecycle=Invoke-RunnerJournalChild $session lifecycle $helper @('lifecycle') 15000 (Join-Path $CaseDirectory 'lifecycle') -ProcessFactory $factory
    if ($lifecycle.exitCode -ne 0 -or $lifecycle.error) { throw 'Lifecycle fixture failed.' }
    Add-RunnerJournalEvent $session phase ([pscustomobject]@{phase='operation_started'})
    $launch=New-RunnerJournalLaunch $session operation $helper @('operation') $CaseDirectory
    $operation=New-Object OverDrafter.StopObserver.DetachedProcess
    $operation.StartInfo.FileName=$helper; $operation.StartInfo.Arguments='operation'; $operation.StartInfo.UseShellExecute=$false
    $operation.StartInfo.RedirectStandardInput=$true; $operation.StartInfo.RedirectStandardOutput=$true; $operation.StartInfo.RedirectStandardError=$true
    $null=$operation.Start(); Set-RunnerJournalCreation $session $launch $operation
    $stdout=$operation.StandardOutput.ReadToEndAsync(); $stderr=$operation.StandardError.ReadToEndAsync()
    $operation.StandardInput.WriteLine('fixture-stdin'); $operation.StandardInput.Close()
    if (-not $operation.WaitForExit(10000) -or $operation.ExitCode -ne 0 -or -not $stdout.Wait(1000) -or -not $stderr.Wait(1000) -or
        $stdout.Result.Trim() -cne 'fixture-stdout' -or $stderr.Result.Trim() -cne 'fixture-stderr') { throw 'Console stream or bounded exit differs.' }
    Set-RunnerJournalExit $session $launch $operation.ExitCode $false
    Add-RunnerJournalEvent $session phase ([pscustomobject]@{phase='operation_completed'})
    Add-RunnerJournalEvent $session phase ([pscustomobject]@{phase='outputs_saved'})
    if (-not $native.WaitForExit(10000) -or $native.ExitCode -ne 0) { throw 'Inert native-shaped process failed.' }
    Set-RunnerJournalExit $session $nativeLaunch $native.ExitCode $false
    Start-Sleep -Milliseconds 500
} catch { [IO.File]::WriteAllText((Join-Path $CaseDirectory 'fixture-error.txt'),($_ | Format-List * -Force | Out-String)); throw }
finally {
    if ($null -ne $incoming) { $incoming.Dispose() }; if ($null -ne $outgoing) { $outgoing.Dispose() }
    foreach ($process in @($operation,$native)) { if ($null -ne $process) { if (-not $process.HasExited) { $process.Kill(); $null=$process.WaitForExit(5000) }; $process.Dispose() } }
    $session.store.lock.Dispose()
}
