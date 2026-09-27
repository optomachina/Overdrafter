#requires -Version 5.1
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'JournalStore.ps1')
. (Join-Path $PSScriptRoot 'ProcessIdentity.ps1')

# This adapter records observations; neither its journal nor a completed child
# grants server stop admission. Callers keep the native process they started.
function New-RunnerJournal($Binding) {
    $store=Open-NativeJournalStore $Binding $true
    try {
        if (-not $store.isNew) { throw 'A prior attempt journal requires recovery, never another launch.' }
        $journal=New-NativeJournal $Binding
        Save-NativeJournalStore $store $journal
        return [pscustomobject]@{store=$store;journal=$journal}
    } catch { $store.lock.Dispose(); throw }
}
function Add-RunnerJournalEvent($Session,[string]$Kind,$Data) {
    $next=Add-NativeJournalEvent $Session.journal $Kind $Data ([DateTime]::UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'"))
    Save-NativeJournalStore $Session.store $next
    $Session.journal=$next
}
# Reserve terminal/uncertainty capacity before an effect. The contract bounds
# paths and every field; eight records/16 KiB cover the known native + helper
# creation, exits, failure and uncertainty even if no further launch is allowed.
function Assert-RunnerJournalCapacity($Journal) {
    $null=Get-NativeJournalSummary $Journal
    if ($Journal.records.Count -gt 2040 -or (ConvertTo-JournalJson $Journal).Length -gt 1983616) {
        throw 'Journal lacks reserved observation capacity for another launch.'
    }
}
function New-RunnerJournalLaunch($Session,[string]$Role,[string]$Executable,[string[]]$Arguments,[string]$WorkingDirectory) {
    Assert-NativeJournalStore $Session.store
    Assert-RunnerJournalCapacity $Session.journal
    $executablePath=Assert-CompanionLocalPath $Executable
    $workingPath=Assert-CompanionLocalPath $WorkingDirectory
    if (-not [IO.File]::Exists($executablePath) -or -not [IO.Directory]::Exists($workingPath)) { throw 'Launch paths must exist.' }
    foreach ($argument in $Arguments) { if ($argument -match '["\r\n]') { throw 'Unsupported process argument.' } }
    $intent=[pscustomobject]@{launchId=[Guid]::NewGuid().ToString();role=$Role;executablePath=$executablePath;
        executableSha256=(Get-FileHash -LiteralPath $executablePath -Algorithm SHA256).Hash.ToLowerInvariant();
        workingDirectory=$workingPath;argumentsSha256=(Get-JournalDigest (ConvertTo-JournalJson @($Arguments)));parentLaunchId=$null}
    Add-RunnerJournalEvent $Session launch_intent $intent
    return [pscustomobject]@{intent=$intent;identity=$null;exited=$false}
}
function Set-RunnerJournalCreation($Session,$Launch,$Process) {
    $observed=Get-RunnerProcessIdentity $Process $Launch.intent.executablePath
    $identity=[pscustomobject]@{launchId=$Launch.intent.launchId;pid=$observed.pid;
        creationTicks=$observed.creationTicks;sessionId=$observed.sessionId;
        executablePath=$observed.executablePath;executableSha256=(Get-FileHash -LiteralPath $observed.executablePath -Algorithm SHA256).Hash.ToLowerInvariant()}
    Add-RunnerJournalEvent $Session process_started $identity
    $Launch.identity=$identity
}
function Set-RunnerJournalExit($Session,$Launch,[int]$ExitCode,[bool]$TerminationRequested) {
    if ($Launch.exited) { return }
    if ($null -eq $Launch.identity) { throw 'An exit cannot replace missing process creation evidence.' }
    $identity=$Launch.identity
    Add-RunnerJournalEvent $Session process_exited ([pscustomobject]@{launchId=$identity.launchId;pid=$identity.pid;
        creationTicks=$identity.creationTicks;sessionId=$identity.sessionId;exitCode=$ExitCode;terminationRequested=$TerminationRequested})
    $Launch.exited=$true
}
# Retain the helper's exact observation when an incomplete journal prevents a
# normal return. Text explains the cause; only the typed code drives policy.
function Throw-RunnerProcessUncertain([string]$Message,$Observation) {
    if ($Observation.error) { $Message += ' ' + $Observation.error }
    $failure=New-Object InvalidOperationException($Message)
    $failure.Data['overdrafter.native.failureCode']='process_uncertain'
    $failure.Data['overdrafter.native.childObservation']=$Observation
    throw $failure
}
# Reuse the pinned retained-child implementation. Its capture callback observes
# that same Process object and starts its actual readers; no PID lookup/adoption.
# Any callback failure follows the helper's existing exact-child cleanup path.
function Get-RunnerEffectBudgetMs($State) {
    $budget=[long]($State.operationLimit-$State.operationTimer.ElapsedMilliseconds)
    if ($null -ne $State.remaining) { $budget=[Math]::Min($budget,[long](& $State.remaining)) }
    if ($budget -lt 1) { throw 'Effect gate deadline expired.' }
    return [int][Math]::Min($budget,30000)
}
function Assert-RunnerEffectRequest($State,$Value,[long]$ExpectedIndex) {
    Assert-CompanionKeys $Value @('schema','action','taskId','attemptId','fence','deadlineAt',
        'pid','creationTicks','nonce','index','effect')
    Assert-CompanionId $Value.nonce
    if ($Value.action -cne 'check' -or $Value.taskId -cne $State.session.journal.binding.taskId -or
        $Value.attemptId -cne $State.session.journal.binding.attemptId -or
        $Value.fence -ne $State.session.journal.binding.fence -or
        $Value.pid -ne $State.launch.identity.pid -or
        $Value.creationTicks -cne $State.launch.identity.creationTicks -or
        $Value.index -ne $ExpectedIndex -or
        $Value.effect -cnotmatch '^[A-Za-z][A-Za-z0-9_.]{0,79}$') {
        throw 'Operation child effect request differs from retained identity.'
    }
    return [pscustomobject]@{schema=$Value.schema;action='check';taskId=$Value.taskId;
        attemptId=$Value.attemptId;fence=$Value.fence;deadlineAt=$Value.deadlineAt;
        launchId=$State.launch.intent.launchId;pid=$Value.pid;creationTicks=$Value.creationTicks;
        nonce=$Value.nonce;index=$Value.index;effect=$Value.effect}
}
function Assert-RunnerEffectRelease($Request,$Release) {
    Assert-CompanionKeys $Release @('schema','action','taskId','attemptId','fence','deadlineAt',
        'launchId','pid','creationTicks','nonce','index','effect','leaseExpiresAt','revision')
    if ($Release.schema -cne $Request.schema -or $Release.action -cne 'release' -or
        $Release.taskId -cne $Request.taskId -or $Release.attemptId -cne $Request.attemptId -or
        $Release.fence -ne $Request.fence -or $Release.deadlineAt -cne $Request.deadlineAt -or
        $Release.launchId -cne $Request.launchId -or $Release.pid -ne $Request.pid -or
        $Release.creationTicks -cne $Request.creationTicks -or $Release.nonce -cne $Request.nonce -or
        $Release.index -ne $Request.index -or $Release.effect -cne $Request.effect) {
        throw 'Companion release differs from exact child effect.'
    }
}
function Send-RunnerEffectRelease($State,$Process,$Release) {
    $write=$Process.StandardInput.WriteLineAsync(($Release | ConvertTo-Json -Compress))
    if (-not $write.Wait([Math]::Min(5000,(Get-RunnerEffectBudgetMs $State)))) { throw 'Operation release write timed out.' }
    $flush=$Process.StandardInput.FlushAsync()
    if (-not $flush.Wait([Math]::Min(5000,(Get-RunnerEffectBudgetMs $State)))) { throw 'Operation release flush timed out.' }
}
function Receive-RunnerEffectReport($State,$Process) {
    $report=$null; $index=0L
    while ($true) {
        $pending=$Process.StandardOutput.ReadLineAsync()
        if (-not $pending.Wait((Get-RunnerEffectBudgetMs $State))) { throw 'Operation child response exceeded authority bound.' }
        $line=$pending.GetAwaiter().GetResult()
        if ($null -eq $line) { break }
        if ([Text.Encoding]::UTF8.GetByteCount($line) -gt 4096) {
            if ($null -ne $report) { throw 'Operation child emitted extra output.' }
            $report=$line; continue
        }
        $value=ConvertFrom-CompanionJson $line
        $schema=$value.PSObject.Properties['schema']
        if ($null -eq $schema -or $schema.Value -cne 'overdrafter.native-effect-authority.v1') {
            if ($null -ne $report) { throw 'Operation child emitted extra output.' }
            $report=$line; continue
        }
        if ($null -ne $report) { throw 'Operation child requested authority after final report.' }
        $request=Assert-RunnerEffectRequest $State $value ($index+1)
        $index=$value.index
        $release=& $State.effectAuthority $request (Get-RunnerEffectBudgetMs $State)
        $null=Get-RunnerEffectBudgetMs $State
        Assert-RunnerEffectRelease $request $release
        Send-RunnerEffectRelease $State $Process $release
    }
    if ($null -eq $report) { throw 'Operation child lacks a final report.' }
    return [string]($report+"`n")
}
function Invoke-RunnerJournalChild($Session,[string]$Role,[string]$Executable,[string[]]$Arguments,[int]$TimeoutMs,[string]$LogBase,[scriptblock]$CreationAcknowledged=$null,[scriptblock]$RemainingMs=$null,[scriptblock]$EffectAuthority=$null) {
    if ($Role -cnotin @('compiler','lifecycle','operation') -or $TimeoutMs -lt 1 -or $TimeoutMs -gt 600000) { throw 'Invalid journal child invocation.' }
    if ($null -ne $CreationAcknowledged -and $Role -cne 'operation') { throw 'Creation observer requires an operation helper.' }
    if ($null -ne $EffectAuthority -and $Role -cnotin @('operation','lifecycle')) { throw 'Effect authority requires a native API helper.' }
    $launch=New-RunnerJournalLaunch $Session $Role $Executable $Arguments ([Environment]::CurrentDirectory)
    $state=[pscustomobject]@{session=$Session;launch=$launch;observer=$CreationAcknowledged;
        effectAuthority=$EffectAuthority;remaining=$RemainingMs;
        operationTimer=[Diagnostics.Stopwatch]::StartNew();operationLimit=$TimeoutMs}
    $capture={
        param($Process)
        $errorTask=$Process.StandardError.ReadToEndAsync()
        Set-RunnerJournalCreation $state.session $state.launch $Process
        # A connected operation child remains inert until each one-use effect
        # release is relayed after this durable creation acknowledgment.
        if ($null -ne $state.observer) { & $state.observer $state.session $state.launch }
        if ($null -eq $state.effectAuthority) {
            return @{stdout=$Process.StandardOutput.ReadToEndAsync();stderr=$errorTask}
        }
        $report=Receive-RunnerEffectReport $state $Process
        return @{stdout=[Threading.Tasks.Task]::FromResult([string]$report);stderr=$errorTask}
    }.GetNewClosure()
    if ($null -ne $RemainingMs) {
        $result=Invoke-OwnedProcess $Executable $Arguments $TimeoutMs $LogBase -CaptureFactory $capture -RemainingMs $RemainingMs -RedirectInput:($null -ne $EffectAuthority)
    } else { $result=Invoke-OwnedProcess $Executable $Arguments $TimeoutMs $LogBase -CaptureFactory $capture -RedirectInput:($null -ne $EffectAuthority) }
    try {
        if ($null -eq $launch.identity) {
            Add-RunnerJournalEvent $Session uncertain ([pscustomobject]@{reason='launch_gap'})
            Throw-RunnerProcessUncertain 'Child launch lacks acknowledged creation evidence; recovery is required.' $result
        }
        if ($null -eq $result.exitCode -or $result.pid -ne $launch.identity.pid) {
            Add-RunnerJournalEvent $Session uncertain ([pscustomobject]@{reason='exit_unobserved'})
            Throw-RunnerProcessUncertain 'Child exit is unconfirmed; recovery is required.' $result
        }
        Set-RunnerJournalExit $Session $launch $result.exitCode $result.terminationRequested
    } catch {
        if ($_.Exception.Data.Contains('overdrafter.native.childObservation')) { throw }
        # A poisoned store can reject even the uncertainty append. Preserve the
        # retained child's cleanup observation outside that immutable history;
        # do not repair the journal or convert cleanup into stop authority.
        Throw-RunnerProcessUncertain ('Child journal observation failed; recovery is required. '+$_.Exception.Message) $result
    }
    return $result
}
