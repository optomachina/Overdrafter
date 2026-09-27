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
        $report=$null; $index=0L
        while ($true) {
            $wait=[int][Math]::Min(30000,($state.operationLimit-$state.operationTimer.ElapsedMilliseconds))
            if ($null -ne $state.remaining) { $wait=[int][Math]::Min($wait,[int](& $state.remaining)) }
            if ($wait -lt 1) { throw 'Effect gate deadline expired.' }
            $pending=$Process.StandardOutput.ReadLineAsync()
            if (-not $pending.Wait($wait)) { throw 'Operation child response exceeded authority bound.' }
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
            Assert-CompanionKeys $value @('schema','action','taskId','attemptId','fence','deadlineAt',
                'pid','creationTicks','nonce','index','effect')
            Assert-CompanionId $value.nonce
            if ($value.action -cne 'check' -or $value.taskId -cne $state.session.journal.binding.taskId -or
                $value.attemptId -cne $state.session.journal.binding.attemptId -or
                $value.fence -ne $state.session.journal.binding.fence -or
                $value.pid -ne $state.launch.identity.pid -or
                $value.creationTicks -cne $state.launch.identity.creationTicks -or
                $value.index -ne ($index+1) -or
                $value.effect -cnotmatch '^[A-Za-z][A-Za-z0-9_.]{0,79}$') {
                throw 'Operation child effect request differs from retained identity.'
            }
            $index=$value.index
            $request=[pscustomobject]@{schema=$value.schema;action='check';taskId=$value.taskId;
                attemptId=$value.attemptId;fence=$value.fence;deadlineAt=$value.deadlineAt;
                launchId=$state.launch.intent.launchId;pid=$value.pid;creationTicks=$value.creationTicks;
                nonce=$value.nonce;index=$value.index;effect=$value.effect}
            $release=& $state.effectAuthority $request
            if ($state.operationTimer.ElapsedMilliseconds -ge $state.operationLimit) {
                throw 'Operation helper exceeded its original timeout.'
            }
            Assert-CompanionKeys $release @('schema','action','taskId','attemptId','fence','deadlineAt',
                'launchId','pid','creationTicks','nonce','index','effect','leaseExpiresAt','revision')
            if ($release.schema -cne $request.schema -or $release.action -cne 'release' -or
                $release.taskId -cne $request.taskId -or $release.attemptId -cne $request.attemptId -or
                $release.fence -ne $request.fence -or $release.deadlineAt -cne $request.deadlineAt -or
                $release.launchId -cne $request.launchId -or $release.pid -ne $request.pid -or
                $release.creationTicks -cne $request.creationTicks -or $release.nonce -cne $request.nonce -or
                $release.index -ne $request.index -or $release.effect -cne $request.effect) {
                throw 'Companion release differs from exact child effect.'
            }
            $write=$Process.StandardInput.WriteLineAsync(($release | ConvertTo-Json -Compress))
            if (-not $write.Wait(5000)) { throw 'Operation release write timed out.' }
            $flush=$Process.StandardInput.FlushAsync()
            if (-not $flush.Wait(5000)) { throw 'Operation release flush timed out.' }
        }
        if ($null -eq $report) { throw 'Operation child lacks a final report.' }
        return @{stdout=[Threading.Tasks.Task]::FromResult([string]($report+"`n"));stderr=$errorTask}
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
