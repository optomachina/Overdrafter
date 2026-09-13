#requires -Version 5.1
# Exercise the actual controller callback from script scope with mocked retained
# processes. No native/worker process, private store, credentials or network.
$ErrorActionPreference='Stop'; Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'test-checkpoint.ps1')
. (Join-Path $PSScriptRoot '../file-admission/OwnedProcess.ps1')
. (Join-Path $PSScriptRoot 'CrashController.ps1')
$script:checks=0; $script:mode='normal'; $script:workerWaitFails=$false
$script:actions=New-Object 'System.Collections.Generic.List[string]'
$script:nativeIdentity=[pscustomobject]@{pid=303;creationTicks='639246383990000000';sessionId=1;executablePath='C:\Native\tool.exe'}
function New-TestCrashState {
    return [pscustomobject]@{checkpoint=$null;native=$null;nativeIdentity=$null;workerExit=$null;nativeExit=$null;
        workerStopRequested=$false;nativeStopRequested=$false;nativeParentPid=$null;nativeVerified=$false;
        workerIdentity=$null;controllerError=$null;stopErrors=(New-Object 'System.Collections.Generic.List[string]')}
}
function New-TestCrashProcess([string]$Role,[int]$Identity) {
    $stream=[pscustomobject]@{}
    $stream | Add-Member -MemberType ScriptMethod -Name ReadToEndAsync -Value {
        $task=New-Object 'Threading.Tasks.TaskCompletionSource[string]'; $task.SetResult('retained worker evidence'); return $task.Task
    }
    $process=[pscustomobject]@{Role=$Role;Id=$Identity;HasExited=$false;ExitCode=-1;KillCount=0;StandardOutput=$stream;StandardError=$stream;
        StartInfo=(New-Object Diagnostics.ProcessStartInfo);Disposed=$false;StartCount=0}
    $process | Add-Member -MemberType ScriptMethod -Name Start -Value { $this.StartCount++; return $true }
    $process | Add-Member -MemberType ScriptMethod -Name Dispose -Value { $this.Disposed=$true }
    $process | Add-Member -MemberType ScriptMethod -Name Kill -Value {
        $script:actions.Add($this.Role+'-kill'); $this.KillCount++
        if ($script:mode -ceq 'native_kill_error' -and $this.Role -ceq 'native') { throw 'Synthetic native kill failure.' }
        if ($script:mode -ceq 'worker_kill_error' -and $this.Role -ceq 'worker') { throw 'Synthetic worker kill failure.' }
        $this.HasExited=$true
    }
    $process | Add-Member -MemberType ScriptMethod -Name WaitForExit -Value {
        param($Timeout)
        if ($this.Role -ceq 'worker' -and $script:workerWaitFails) { return $false }
        return $this.HasExited
    }
    return $process
}
function Get-RunnerProcessIdentity($Process,[string]$Executable) {
    if ($Process.Id -eq 42) {
        $copy=Copy-JournalFixture $owner
        if ($script:mode -ceq 'wrong_owner') { $copy.pid=43 }
        return $copy
    }
    $copy=Copy-JournalFixture $script:nativeIdentity
    if ($script:mode -ceq 'wrong_native') { $copy.creationTicks='639246383991000000' }
    return $copy
}
function New-TestNativeState {
    $value=New-TestCrashState; $value.native=New-TestCrashProcess native 303
    $value.nativeVerified=$true; $value.nativeIdentity=$script:nativeIdentity; $value.workerIdentity=$owner; $value.nativeParentPid=42
    return $value
}
$state=New-TestNativeState; $worker=New-TestCrashProcess worker 42
Stop-QualificationWorker $worker $state
Check (($script:actions -join ',') -ceq 'worker-kill,native-kill') 'confirmed worker stop precedes retained native stop'
Check ($state.workerExit -eq -1 -and $state.nativeExit -eq -1 -and $state.stopErrors.Count -eq 0) 'both exact exits retained'
Stop-QualificationWorker $worker $state
Check ($worker.KillCount -eq 1 -and $state.native.KillCount -eq 1) 'repeat observation never repeats kill'
$script:workerWaitFails=$true; $state=New-TestNativeState; $worker=New-TestCrashProcess worker 42
Stop-QualificationWorker $worker $state
Check ($state.native.KillCount -eq 0 -and $null -eq $state.workerExit -and $state.stopErrors.Count -gt 0) 'unconfirmed worker blocks native cleanup'
$script:workerWaitFails=$false; $state=New-TestNativeState; $state.nativeVerified=$false
Stop-QualificationWorker (New-TestCrashProcess worker 42) $state
Check ($state.native.KillCount -eq 0 -and $state.stopErrors.Count -gt 0) 'unverified native is never killed'
$script:mode='wrong_native'; $state=New-TestNativeState
Stop-QualificationWorker (New-TestCrashProcess worker 42) $state
Check ($state.native.KillCount -eq 0 -and $state.stopErrors.Count -gt 0) 'changed retained identity blocks native cleanup'
$script:mode='native_kill_error'; $state=New-TestNativeState
Stop-QualificationWorker (New-TestCrashProcess worker 42) $state
Stop-QualificationNative $state
Check ($state.native.KillCount -eq 1 -and $null -eq $state.nativeExit -and $state.stopErrors.Count -gt 0) 'failed native kill remains unconfirmed without another kill'

# Extract only the trusted source's callback assignment. It must resolve these
# script-local helpers when invoked from a nested consumer, as on Desktop 5.1.
$tokens=$null; $errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'qualify-worker-crash.ps1'),[ref]$tokens,[ref]$errors)
Check ($errors.Count -eq 0) 'controller parses'
$assignment=@($ast.FindAll({param($node) $node -is [Management.Automation.Language.AssignmentStatementAst] -and
    $node.Left -is [Management.Automation.Language.VariableExpressionAst] -and $node.Left.VariablePath.UserPath -ceq 'capture'},$true))
Check ($assignment.Count -eq 1) 'one controller callback'
$root=Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid().ToString())
[void][IO.Directory]::CreateDirectory($root); $checkpointPath=Join-Path $root 'checkpoint.json'
[IO.File]::WriteAllText($checkpointPath,'{}')
$Boundary='native_launch_intent'; $SourceCommit='a'*40; $executable='C:\Windows\powershell.exe'
$script:checkpoint=New-PreparedQualificationCheckpoint $Boundary $binding $intent $owner
function Read-PreparedJournalSupervisor {
    if ($script:mode -ceq 'read_error') { throw 'Synthetic checkpoint read failure.' }
    return $script:checkpoint
}
function Get-PreparedHash { return 'a'*64 }
function Write-PreparedJson {
    if ($script:mode -ceq 'write_error') { throw 'Synthetic controller write failure.' }
    return 'a'*64
}
function Invoke-TestCrashCapture($Callback,$Worker) {
    return Invoke-QualificationWorker $Worker $executable @('-NoProfile') (Join-Path $root 'worker') $state $Callback
}
try {
    . ([scriptblock]::Create($assignment[0].Extent.Text))
    foreach ($mode in @('normal','read_error','write_error','wrong_owner')) {
        $script:mode=$mode; $state=New-TestCrashState; $worker=New-TestCrashProcess worker 42
        $captured=Invoke-TestCrashCapture $capture $worker
        Check ($captured.stdout -ceq 'retained worker evidence' -and $captured.stderr -ceq 'retained worker evidence') ('actual reader evidence returned '+$mode)
        Check ($worker.StartCount -eq 1 -and $worker.Disposed -and $worker.KillCount -eq 1) ('complete invocation uses one start and stop '+$mode)
        Check ($worker.HasExited -and $state.workerExit -eq -1) ('direct worker cleanup '+$mode)
        if ($mode -ceq 'normal') { Check ($null -eq $state.controllerError -and $null -ne $state.checkpoint) 'script-scope helpers resolve in callback' }
        else { Check ($null -ne $state.controllerError) ('controller error retained '+$mode) }
    }
    # Inject an already verified retained resource to exercise the callback's
    # catch path after ownership capture; this does not qualify real ancestry.
    $script:mode='write_error'; $state=New-TestNativeState; $worker=New-TestCrashProcess worker 42
    $captured=Invoke-TestCrashCapture $capture $worker
    Check ($null -ne $state.controllerError -and $worker.KillCount -eq 1 -and $state.native.KillCount -eq 1 -and
        $state.nativeExit -eq -1 -and $captured.stdout -ceq 'retained worker evidence') 'callback write failure preserves output and cleans verified native after worker'
    $script:mode='worker_kill_error'; $state=New-TestNativeState; $worker=New-TestCrashProcess worker 42
    $captured=Invoke-TestCrashCapture $capture $worker
    Check ($worker.KillCount -eq 1 -and $state.native.KillCount -eq 0 -and $null -eq $captured.exitCode -and
        $null -ne $captured.error -and -not $captured.terminated) 'complete invocation never repeats a failed worker stop or touches native'
    Check ($captured.stdout -ceq 'retained worker evidence' -and $worker.Disposed) 'unconfirmed worker preserves readers and closes retained wrapper'
    $script:mode='normal'; $script:workerWaitFails=$true; $state=New-TestNativeState; $worker=New-TestCrashProcess worker 42
    $captured=Invoke-TestCrashCapture $capture $worker
    Check ($worker.KillCount -eq 1 -and $state.native.KillCount -eq 0 -and $null -eq $captured.exitCode -and
        $null -ne $captured.error) 'complete invocation treats an unconfirmed exit as failure without another kill'
    $script:workerWaitFails=$false; $state=New-TestCrashState; $worker=New-TestCrashProcess worker 42
    $captured=Invoke-TestCrashCapture {throw 'Synthetic uncaught callback failure.'} $worker
    Check ($worker.KillCount -eq 1 -and $captured.exitCode -eq -1 -and $null -ne $captured.error -and
        $captured.stdout -ceq 'retained worker evidence') 'outer callback failure retains streams and performs one cleanup'
} finally { [IO.Directory]::Delete($root,$true) }
[pscustomobject]@{schema='overdrafter.worker-crash-controller-tests.v1';passed=$true;assertions=$script:checks;
    nativeActions=0;processes='mocked';storage='mocked'} | ConvertTo-Json -Compress
