#requires -Version 5.1
# Real controller functions with inert process/query seams. No CAD, process
# creation, termination, credentials, private storage or network access.
$ErrorActionPreference='Stop'; Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'test-native-call.ps1')
. (Join-Path $PSScriptRoot '../file-admission/OwnedProcess.ps1')
. (Join-Path $PSScriptRoot 'NativeCallController.ps1')
$script:checks=0; $script:mode='normal'
$script:actions=New-Object 'System.Collections.Generic.List[string]'
$script:processes=@{}
function New-CallTestProcess([string]$Role,$Identity) {
    $stream=[pscustomobject]@{}
    $stream | Add-Member ScriptMethod ReadToEndAsync {
        $task=New-Object 'Threading.Tasks.TaskCompletionSource[string]'; $task.SetResult('call worker evidence'); return $task.Task
    }
    $process=[pscustomobject]@{Role=$Role;Identity=$Identity;Id=$Identity.pid;HasExited=$false;ExitCode=-1;KillCount=0;Disposed=$false;
        StartInfo=(New-Object Diagnostics.ProcessStartInfo);StandardOutput=$stream;StandardError=$stream;StartCount=0}
    $process | Add-Member ScriptMethod Start { $this.StartCount++; return $true }
    $process | Add-Member ScriptMethod Dispose { $this.Disposed=$true }
    $process | Add-Member ScriptMethod Kill {
        $script:actions.Add($this.Role+'-kill'); $this.KillCount++
        if ($script:mode -ceq ($this.Role+'_kill_error')) { throw 'Synthetic kill error.' }
        $this.HasExited=$true
    }
    $process | Add-Member ScriptMethod WaitForExit {
        param($Timeout)
        $script:actions.Add($this.Role+'-wait')
        if ($script:mode -ceq ($this.Role+'_wait_error')) { return $false }
        return $this.HasExited
    }
    return $process
}
function Get-RunnerProcessIdentity($Process,[string]$Executable) {
    if ($script:mode -ceq 'released_during_query') { [IO.File]::WriteAllText($releasedPath,'{}') }
    if ($script:mode -ceq 'clock_expires_during_query') { $script:callClock.ElapsedMilliseconds=10000 }
    if ($script:mode -ceq 'wall_expires_during_query') { $script:callNow=$now.AddSeconds(10) }
    if ($script:mode -ceq ($Process.Role+'_query_error')) { throw 'Synthetic process query error.' }
    $copy=Copy-JournalFixture $Process.Identity
    switch ($script:mode) {
        wrong_ticks { if ($Process.Role -ne 'worker') { $copy.creationTicks='639246383999000000' } }
        wrong_pid { if ($Process.Role -ne 'worker') { $copy.pid=999 } }
        wrong_path { if ($Process.Role -ne 'worker') { $copy.executablePath='C:\Foreign\wrong.exe' } }
        wrong_session { if ($Process.Role -ne 'worker') { $copy.sessionId=2 } }
        wrong_owner { if ($Process.Role -eq 'worker') { $copy.creationTicks='639246383999000000' } }
    }
    return $copy
}
function Open-NativeCallProcess([int]$ProcessId) {
    if ($script:mode -ceq 'lookup_error') { throw 'Synthetic lookup error.' }
    return $script:processes[$ProcessId]
}
function Get-NativeCallParent([int]$ProcessId) {
    if ($script:mode -ceq 'parent_error') { throw 'Synthetic parent query error.' }
    if ($script:mode -ceq 'wrong_parent') { return 999 }
    if ($script:mode -ceq 'native_parent_error' -and $ProcessId -eq $receipt.nativePid) { throw 'Synthetic native parent query error.' }
    if ($script:mode -ceq 'owner_exited_during_parent') { $script:processes[$owner.pid].HasExited=$true }
    return $owner.pid
}
function Get-PreparedHash([string]$Path) {
    if ($script:mode -ceq 'wrong_hash') { return 'e'*64 }
    if ($Path -ceq $receipt.helperPath) { return $receipt.helperSha256 }
    return $receipt.nativeSha256
}
function New-CallTestCase {
    $script:actions.Clear(); $script:processes=@{}
    $state=New-NativeCallControllerState
    $state.workerIdentity=Copy-JournalFixture $owner
    $worker=New-CallTestProcess worker $state.workerIdentity
    $script:processes[$worker.Id]=$worker
    foreach ($role in @('helper','native')) {
        $identity=[pscustomobject]@{pid=$receipt.($role+'Pid');creationTicks=$receipt.($role+'CreationTicks');sessionId=$receipt.sessionId;
            executablePath=$receipt.($role+'Path')}
        $script:processes[$identity.pid]=New-CallTestProcess $role $identity
    }
    return [pscustomobject]@{state=$state;worker=$worker}
}
function Set-CallTestHandles($Case) {
    Set-NativeCallDescendant $Case.worker $Case.state $receipt helper
    Set-NativeCallDescendant $Case.worker $Case.state $receipt native
}
$root=Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid().ToString())
[void][IO.Directory]::CreateDirectory($root)
$releasedPath=Join-Path $root 'released.json'
$now=[DateTimeOffset]::Parse('2026-09-10T12:01:01Z')
$script:callNow=$now; $script:callClock=[pscustomobject]@{ElapsedMilliseconds=100}
function Get-NativeCallUtcNow {
    if ($null -eq $script:callNow) { return [DateTimeOffset]::UtcNow }
    return $script:callNow
}
try {
    $case=New-CallTestCase; Set-CallTestHandles $case
    Assert-NativeCallActive $receipt $case.state $case.worker $releasedPath $script:callClock
    Check ($case.state.helperVerified -and $case.state.nativeVerified) 'both exact live descendants retained'
    Stop-NativeCallWorker $case.worker $case.state
    Check (($script:actions -join ',') -ceq 'worker-kill,worker-wait,helper-kill,helper-wait,native-kill,native-wait') 'confirmed worker then helper then native exit order'
    Check ($case.state.workerExit -eq -1 -and $case.state.helperExit -eq -1 -and $case.state.nativeExit -eq -1 -and
        $case.state.stopErrors.Count -eq 0) 'all three exits retained'
    Stop-NativeCallWorker $case.worker $case.state
    Check ($case.worker.KillCount -eq 1 -and $case.state.helper.KillCount -eq 1 -and $case.state.native.KillCount -eq 1) 'repeat cleanup never repeats kill'

    foreach ($scenario in @('lookup_error','parent_error','wrong_parent','wrong_ticks','wrong_pid','wrong_path','wrong_session',
        'wrong_hash','wrong_owner','owner_exited_during_parent','helper_query_error')) {
        $script:mode=$scenario; $case=New-CallTestCase
        Deny { Set-NativeCallDescendant $case.worker $case.state $receipt helper } ('reject live ownership '+$scenario)
        Check ($null -eq $case.state.helper -and -not $case.state.helperVerified -and
            $script:processes[$receipt.helperPid].KillCount -eq 0) ('unverified process never adopted or killed '+$scenario)
        if ($scenario -notin @('lookup_error','wrong_owner')) {
            Check $script:processes[$receipt.helperPid].Disposed ('failed lookup handle disposed '+$scenario)
        }
    }
    $script:mode='normal'; $case=New-CallTestCase
    $script:processes[$receipt.helperPid].HasExited=$true
    Deny { Set-NativeCallDescendant $case.worker $case.state $receipt helper } 'already exited process refused'
    $case=New-CallTestCase; Set-CallTestHandles $case
    Deny { Set-NativeCallDescendant $case.worker $case.state $receipt helper } 'cannot replace an owned handle'

    foreach ($scenario in @('worker_kill_error','worker_wait_error','helper_kill_error','helper_wait_error','helper_query_error',
        'native_kill_error','native_wait_error','native_query_error')) {
        $script:mode='normal'; $case=New-CallTestCase; Set-CallTestHandles $case
        $script:mode=$scenario; Stop-NativeCallWorker $case.worker $case.state
        Stop-NativeCallWorker $case.worker $case.state
        Check ($case.state.stopErrors.Count -gt 0) ('failed cleanup is retained '+$scenario)
        Check ($case.worker.KillCount -le 1 -and $case.state.helper.KillCount -le 1 -and $case.state.native.KillCount -le 1) ('no repeated kill '+$scenario)
        if ($scenario.StartsWith('worker')) {
            Check ($null -eq $case.state.workerExit -and $case.state.helper.KillCount -eq 0 -and $case.state.native.KillCount -eq 0) ('unknown worker stop blocks descendants '+$scenario)
        } elseif ($scenario.StartsWith('helper')) {
            Check ($null -eq $case.state.helperExit -and $case.state.native.KillCount -eq 0) ('unknown helper stop blocks native '+$scenario)
        } else { Check ($null -eq $case.state.nativeExit) ('unknown native stop preserved '+$scenario) }
    }
    $script:mode='normal'; $case=New-CallTestCase
    Set-NativeCallDescendant $case.worker $case.state $receipt native
    Stop-NativeCallWorker $case.worker $case.state
    Check ($case.state.native.KillCount -eq 0 -and $case.state.stopErrors.Count -gt 0) 'native cannot stop when helper was never verified'
    $case=New-CallTestCase; Set-NativeCallDescendant $case.worker $case.state $receipt helper
    $script:mode='wrong_parent'
    Deny { Set-NativeCallDescendant $case.worker $case.state $receipt native } 'second capture failure retained'
    $script:mode='normal'; Stop-NativeCallWorker $case.worker $case.state
    Check ($case.state.helper.KillCount -eq 1 -and $script:processes[$receipt.nativePid].KillCount -eq 0) 'partial capture cleans only verified helper'

    foreach ($scenario in @('late_wall','future_wall','late_monotonic','negative_monotonic','released','helper_exited','native_exited',
        'worker_exited','helper_unverified','native_unverified','wrong_owner','wrong_ticks','already_stopping','released_during_query',
        'clock_expires_during_query','wall_expires_during_query')) {
        $script:mode='normal'; $case=New-CallTestCase; Set-CallTestHandles $case
        $time=$now; $elapsed=100
        switch ($scenario) {
            late_wall { $time=$now.AddSeconds(9) }
            future_wall { $time=$now.AddSeconds(-2) }
            late_monotonic { $elapsed=10000 }
            negative_monotonic { $elapsed=-1 }
            released { [IO.File]::WriteAllText($releasedPath,'{}') }
            helper_exited { $case.state.helper.HasExited=$true }
            native_exited { $case.state.native.HasExited=$true }
            worker_exited { $case.worker.HasExited=$true }
            helper_unverified { $case.state.helperVerified=$false }
            native_unverified { $case.state.nativeVerified=$false }
            wrong_owner { $script:mode=$scenario }
            wrong_ticks { $script:mode=$scenario }
            already_stopping { $case.state.workerStopRequested=$true }
            released_during_query { $script:mode=$scenario }
            clock_expires_during_query { $script:mode=$scenario }
            wall_expires_during_query { $script:mode=$scenario }
        }
        $script:callNow=$time; $script:callClock=[pscustomobject]@{ElapsedMilliseconds=$elapsed}
        Deny { Assert-NativeCallActive $receipt $case.state $case.worker $releasedPath $script:callClock } ('call must remain live '+$scenario)
        Check ($script:actions.Count -eq 0) ('freshness rejection performs no effects '+$scenario)
        if ([IO.File]::Exists($releasedPath)) { [IO.File]::Delete($releasedPath) }
    }

    # Exercise the actual invoker finally path: the default two-process cleanup
    # must never race or bypass this three-process policy after callback failure.
    foreach ($scenario in @('normal','helper_kill_error','worker_wait_error')) {
        $script:mode='normal'; $case=New-CallTestCase; Set-CallTestHandles $case; $script:mode=$scenario
        $result=Invoke-QualificationWorker $case.worker $owner.executablePath @('-NoProfile') (Join-Path $root 'worker') $case.state `
            { throw 'Synthetic callback failure after ownership capture.' } { param($Worker,$State) Stop-NativeCallWorker $Worker $State }
        Check ($result.stdout -ceq 'call worker evidence' -and $result.stderr -ceq 'call worker evidence' -and
            $result.error -match 'Synthetic callback failure' -and $case.worker.Disposed) ('invoker retains readers and errors '+$scenario)
        Check ($case.worker.KillCount -eq 1 -and $case.state.helper.KillCount -le 1 -and $case.state.native.KillCount -le 1) ('invoker shares stop state '+$scenario)
        if ($scenario -ceq 'normal') { Check ($case.state.nativeExit -eq -1) 'invoker cleans all exact resources' }
        else { Check ($case.state.native.KillCount -eq 0) ('invoker never bypasses failed predecessor '+$scenario) }
    }

    # Execute the actual entrypoint callback through the real qualification
    # invoker, replacing only file reads/writes and Windows process observations.
    $tokens=$null; $parseErrors=$null
    $ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'qualify-native-call.ps1'),[ref]$tokens,[ref]$parseErrors)
    Check ($parseErrors.Count -eq 0) 'native call entrypoint parses'
    # Exercise the entrypoint's actual post-write normalization with real file
    # bytes before installing the file seams below. The Windows failure passed
    # an OrderedDictionary into the strict wire validator; mocked callbacks had
    # previously supplied only a pre-parsed fixture and missed that boundary.
    $jobAssignments=@($ast.FindAll({param($node) $node -is [Management.Automation.Language.AssignmentStatementAst] -and
        $node.Left -is [Management.Automation.Language.VariableExpressionAst] -and $node.Left.VariablePath.UserPath -ceq 'job'},$true))
    Check ($jobAssignments.Count -eq 2) 'constructed job is normalized once from serialized bytes'
    $jobPath=Join-Path $root 'job.json'; [void](Write-PreparedJson $jobPath $job)
    $jobHash=(Read-PreparedJson $jobPath).sha256
    $construction=[ordered]@{}; foreach($property in $job.PSObject.Properties){$construction[$property.Name]=$property.Value}
    $job=$construction
    Deny { Assert-PreparedQualificationScope $job $binding $source } 'construction dictionary is not a strict wire object'
    . ([scriptblock]::Create($jobAssignments[1].Extent.Text))
    Assert-PreparedQualificationScope $job $binding $source
    Check ($job -is [pscustomobject] -and $job.createdAt -is [string] -and (Read-PreparedJson $jobPath).sha256 -ceq $jobHash) 'serialized job has canonical types and unchanged bytes'
    $assignment=@($ast.FindAll({param($node) $node -is [Management.Automation.Language.AssignmentStatementAst] -and
        $node.Left -is [Management.Automation.Language.VariableExpressionAst] -and $node.Left.VariablePath.UserPath -ceq 'capture'},$true))
    Check ($assignment.Count -eq 1) 'single entrypoint callback'
    . ([scriptblock]::Create($assignment[0].Extent.Text))
    $checkpointPath=Join-Path $root 'entered.json'; [IO.File]::WriteAllText($checkpointPath,'{}')
    $SourceCommit=$source; $Boundary='open_call'; $executable=$owner.executablePath; $journalPath=Join-Path $root 'journal.dpapi'
    $script:writeCount=0
    $script:callNow=$null
    function Read-PreparedJson([string]$Path) {
        if ($script:mode -ceq 'read_error') { throw 'Synthetic callback read error.' }
        if ($Path.EndsWith('settings.json')) { return [pscustomobject]@{value=(Copy-JournalFixture $settings)} }
        $copy=Copy-JournalFixture $receipt
        $copy.utc=[DateTime]::UtcNow.ToString('o')
        if ($script:mode -ceq 'receipt_mismatch') { $copy.sourceCommit='c'*40 }
        return [pscustomobject]@{value=$copy}
    }
    function Read-PreparedJournalSupervisor { return Copy-JournalFixture $progress }
    function Write-PreparedJson {
        $script:writeCount++
        if ($script:mode -ceq 'write_error') { throw 'Synthetic callback write error.' }
        return 'a'*64
    }
    $testDrive=$false
    if (-not (Get-PSDrive -Name C -ErrorAction SilentlyContinue)) {
        New-PSDrive -Name C -PSProvider FileSystem -Root $root | Out-Null; $testDrive=$true
    }
    try {
        foreach ($scenario in @('normal','read_error','receipt_mismatch','write_error','native_parent_error','helper_kill_error')) {
            $script:mode=$scenario; $case=New-CallTestCase; $state=$case.state; $script:writeCount=0
            $captureState=[pscustomobject]@{checkpoint=$null;cipherSha256=$null;controllerError=$null}
            $result=Invoke-QualificationWorker $case.worker $executable @('-NoProfile') (Join-Path $root 'worker') $state $capture `
                {param($Worker,$State) Stop-NativeCallWorker $Worker $State}
            Check ($case.worker.KillCount -eq 1 -and $result.stdout -ceq 'call worker evidence') ('actual callback retains worker observations '+$scenario)
            if ($scenario -ceq 'normal') {
                Check ($null -eq $captureState.controllerError -and $null -eq $result.error -and $script:writeCount -eq 2 -and
                    $state.helperExit -eq -1 -and $state.nativeExit -eq -1) 'actual callback validates and records complete interruption'
            } else {
                Check ($null -ne $captureState.controllerError) ('actual callback records failure '+$scenario)
                if ($scenario -in @('read_error','receipt_mismatch')) {
                    Check ($script:processes[$receipt.helperPid].KillCount -eq 0 -and $script:processes[$receipt.nativePid].KillCount -eq 0) ('early error never adopts children '+$scenario)
                } elseif ($scenario -ceq 'native_parent_error') {
                    Check ($state.helperExit -eq -1 -and $null -eq $state.native -and $script:processes[$receipt.nativePid].KillCount -eq 0) 'actual partial capture cleans only verified helper'
                } elseif ($scenario -ceq 'helper_kill_error') {
                    Check ($state.helper.KillCount -eq 1 -and $state.native.KillCount -eq 0) 'actual callback and finally never repeat failed stop'
                } else { Check ($state.helperExit -eq -1 -and $state.nativeExit -eq -1) 'actual write failure cleans both retained children' }
            }
        }
    } finally { if ($testDrive) { Remove-PSDrive -Name C } }
} finally { [IO.Directory]::Delete($root,$true) }
[pscustomobject]@{schema='overdrafter.native-call-controller-tests.v1';passed=$true;assertions=$script:checks;
    nativeActions=0;processes='mocked';storage='mocked'} | ConvertTo-Json -Compress
