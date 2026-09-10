#requires -Version 5.1
# In-memory adapter checks. Mock process/storage boundaries; never launch CAD.
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'JournalRunner.ps1')
. (Join-Path $PSScriptRoot 'test-contract.ps1')
$script:checks=0; $script:spawns=0; $script:mode='normal'
function New-TestSession {
    return [pscustomobject]@{journal=(New-NativeJournal $binding);store=[pscustomobject]@{poisoned=$false;failKind=$null;ack=$null}}
}
function Assert-NativeJournalStore($Store) { if ($Store.poisoned) { throw 'Synthetic poisoned store.' } }
function Save-NativeJournalStore($Store,$Journal) {
    Assert-NativeJournalStore $Store
    if ($Store.failKind -ceq $Journal.records[-1].kind) { $Store.poisoned=$true; throw 'Synthetic failed acknowledgement.' }
    $Store.ack=$Journal.headSha256
}
# Replace only path admission/disk I/O; exercise the real append and callback.
function New-RunnerJournalLaunch($Session,[string]$Role,[string]$Executable,[string[]]$Arguments,[string]$WorkingDirectory) {
    Assert-NativeJournalStore $Session.store
    Assert-RunnerJournalCapacity $Session.journal
    $intent=Intent 200 $Role $null
    Add-RunnerJournalEvent $Session launch_intent $intent
    return [pscustomobject]@{intent=$intent;identity=$null;exited=$false}
}
function Get-FileHash { return [pscustomobject]@{Hash=('a'*64)} }
function Get-RunnerProcessIdentity($Process) {
    return [pscustomobject]@{pid=$Process.Id;creationTicks=$Process.StartTime.ToUniversalTime().Ticks.ToString();
        sessionId=$Process.SessionId;executablePath='C:\Native\tool.exe'}
}
function Invoke-OwnedProcess($Executable,$Arguments,$TimeoutMs,$LogBase,[scriptblock]$CaptureFactory) {
    $script:spawns++
    $result=@{pid=42;exitCode=0;terminationRequested=$false;timedOut=$false;error=$null;stdout='';stderr=''}
    if ($script:mode -ceq 'creation_gap') { return $result }
    $stream=[pscustomobject]@{}
    $stream | Add-Member -MemberType ScriptMethod -Name ReadToEndAsync -Value {
        $source=New-Object 'Threading.Tasks.TaskCompletionSource[string]'
        $source.SetResult(''); return $source.Task
    }
    $process=[pscustomobject]@{Handle=1;Id=42;StartTime=([DateTime]::UtcNow.AddSeconds(-1));SessionId=1;
        MainModule=[pscustomobject]@{FileName='C:\Native\tool.exe'};StandardOutput=$stream;StandardError=$stream}
    try {
        $capture=& $CaptureFactory $process
        if ($capture.stdout -isnot [Threading.Tasks.Task[string]] -or $capture.stderr -isnot [Threading.Tasks.Task[string]]) { throw 'Missing real reader tasks.' }
    } catch { $result.error=$_.Exception.Message }
    if ($script:mode -ceq 'exit_gap') { $result.exitCode=$null }
    return $result
}
$session=New-TestSession
$result=Invoke-RunnerJournalChild $session compiler 'C:\Native\tool.exe' @() 1000 'unused'
Check ($script:spawns -eq 1 -and $null -eq $result.error) 'observed child callback succeeds'
Check ($session.journal.records.Count -eq 3) 'intent creation exit persisted'
Check ($session.journal.records[0].kind -ceq 'launch_intent' -and $session.journal.records[1].kind -ceq 'process_started' -and $session.journal.records[2].kind -ceq 'process_exited') 'effect evidence ordered'
Check ($session.store.ack -ceq $session.journal.headSha256) 'returned history was acknowledged'
Check ((Get-NativeJournalSummary $session.journal).recordedProcessesExited -and -not (Get-NativeJournalSummary $session.journal).stopAdmission) 'recorded exit grants no authority'
foreach ($kind in @('launch_intent','process_started','process_exited')) {
    $session=New-TestSession; $session.store.failKind=$kind; $script:spawns=0
    Deny { Invoke-RunnerJournalChild $session compiler 'C:\Native\tool.exe' @() 1000 'unused' } ('failed acknowledgement '+$kind)
    Check $session.store.poisoned ('handle poisoned '+$kind)
    if ($kind -ceq 'launch_intent') { Check ($script:spawns -eq 0) 'no spawn before acknowledged intent' }
    else { Check ((Get-NativeJournalSummary $session.journal).recoveryRequired) ('unresolved history '+$kind) }
    Deny { Invoke-RunnerJournalChild $session compiler 'C:\Native\tool.exe' @() 1000 'unused' } 'failed writer cannot launch again'
}
foreach ($mode in @('creation_gap','exit_gap')) {
    $session=New-TestSession; $script:mode=$mode
    Deny { Invoke-RunnerJournalChild $session compiler 'C:\Native\tool.exe' @() 1000 'unused' } ('unconfirmed process '+$mode)
    $summary=Get-NativeJournalSummary $session.journal
    Check ($summary.recoveryRequired -and -not $summary.recordedProcessesExited) ('gap is not termination proof '+$mode)
}
$script:mode='normal'; $session=New-TestSession; $script:spawns=0
Deny { Invoke-RunnerJournalChild $session native 'C:\Native\tool.exe' @() 1000 'unused' } 'child helper cannot start native'
Deny { Invoke-RunnerJournalChild $session compiler 'C:\Native\tool.exe' @() 0 'unused' } 'invalid timeout has no launch'
Check ($script:spawns -eq 0 -and $session.journal.records.Count -eq 0) 'invalid invocation is effect-free'
# Exercise the functions actually shared with preview execution. No journal is
# implicit in those callers, and matching exception text cannot confer a code.
. (Join-Path $PSScriptRoot '../prepared-preview/PreviewContract.ps1')
. (Get-PreviewRuntimeFunctions (Join-Path $PSScriptRoot '../prepared-dimension/run.ps1'))
function Invoke-OwnedProcess { return 'legacy-child' }
Check ((Invoke-PreparedChild compiler 'unused' @() 1000 'unused') -ceq 'legacy-child') 'legacy and preview caller omits journal state'
$caught=$null
try { Throw-PreparedFailure 'native_startup_timeout' 'Synthetic startup deadline.' } catch { $caught=$_.Exception }
Check ($null -ne $caught -and $caught.Data['overdrafter.native.failureCode'] -ceq 'native_startup_timeout') 'typed native failure survives PowerShell catch'
$caught=$null
try { throw 'Synthetic startup deadline.' } catch { $caught=$_.Exception }
Check (-not $caught.Data.Contains('overdrafter.native.failureCode')) 'matching human text is not a typed failure'
[pscustomobject]@{schema='overdrafter.journal-runner-tests.v1';passed=$true;assertions=$script:checks;nativeActions=0;storage='mocked';processes='mocked'} | ConvertTo-Json -Compress
