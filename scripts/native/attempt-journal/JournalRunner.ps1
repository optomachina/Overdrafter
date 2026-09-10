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
function Invoke-RunnerJournalChild($Session,[string]$Role,[string]$Executable,[string[]]$Arguments,[int]$TimeoutMs,[string]$LogBase,[scriptblock]$CreationAcknowledged=$null) {
    if ($Role -cnotin @('compiler','lifecycle','operation') -or $TimeoutMs -lt 1 -or $TimeoutMs -gt 600000) { throw 'Invalid journal child invocation.' }
    if ($null -ne $CreationAcknowledged -and $Role -cne 'operation') { throw 'Creation observer requires an operation helper.' }
    $launch=New-RunnerJournalLaunch $Session $Role $Executable $Arguments ([Environment]::CurrentDirectory)
    $state=[pscustomobject]@{session=$Session;launch=$launch;observer=$CreationAcknowledged}
    $capture={
        param($Process)
        Set-RunnerJournalCreation $state.session $state.launch $Process
        # The child can already be in COM. Publish qualification evidence only
        # after the exact creation record has completed durable acknowledgment.
        if ($null -ne $state.observer) { & $state.observer $state.session $state.launch }
        return @{stdout=$Process.StandardOutput.ReadToEndAsync();stderr=$Process.StandardError.ReadToEndAsync()}
    }.GetNewClosure()
    $result=Invoke-OwnedProcess $Executable $Arguments $TimeoutMs $LogBase -CaptureFactory $capture
    if ($null -eq $launch.identity) {
        Add-RunnerJournalEvent $Session uncertain ([pscustomobject]@{reason='launch_gap'})
        Throw-RunnerProcessUncertain 'Child launch lacks acknowledged creation evidence; recovery is required.' $result
    }
    if ($null -eq $result.exitCode -or $result.pid -ne $launch.identity.pid) {
        Add-RunnerJournalEvent $Session uncertain ([pscustomobject]@{reason='exit_unobserved'})
        Throw-RunnerProcessUncertain 'Child exit is unconfirmed; recovery is required.' $result
    }
    Set-RunnerJournalExit $Session $launch $result.exitCode $result.terminationRequested
    return $result
}
