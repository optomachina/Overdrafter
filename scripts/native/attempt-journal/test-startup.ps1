#requires -Version 5.1
# Actual readiness coordinator with a deterministic clock and native/probe stubs.
# No process, COM, native file, private store or wall-clock wait is performed.
$ErrorActionPreference='Stop'; Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'QualificationCheckpoint.ps1')
$tokens=$null; $errors=$null
$path=Join-Path $PSScriptRoot '../prepared-dimension/run.ps1'
$ast=[Management.Automation.Language.Parser]::ParseFile($path,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Prepared runner does not parse.'}
$names=@('Invoke-PreparedReadinessProbe','Wait-PreparedNativeReady','Throw-PreparedFailure')
foreach($name in $names){
    $definitions=@($ast.FindAll({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $name},$true))
    if($definitions.Count -ne 1){throw ('Missing unique readiness helper: '+$name)}
    . ([scriptblock]::Create($definitions[0].Extent.Text))
}
$script:checks=0; $script:now=0; $script:mode='late_ready'; $script:probeCalls=0
$supervisor=[ordered]@{}
function Check([bool]$Value,[string]$Label){$script:checks++;if(-not $Value){throw ('Startup check failed: '+$Label)}}
function New-PreparedStartupClock {
    $clock=[pscustomobject]@{Started=$script:now}
    $clock | Add-Member -MemberType ScriptProperty -Name ElapsedMilliseconds -Value {return $script:now-$this.Started}
    $clock | Add-Member -MemberType ScriptMethod -Name Stop -Value {}
    return $clock
}
$native=[pscustomobject]@{}
$native | Add-Member -MemberType ScriptMethod -Name WaitForInputIdle -Value {
    param($Timeout)
    Check ($Timeout -eq 60000) 'fixed GUI budget'
    if($script:mode -ceq 'gui_error'){throw $script:probeFailure}
    if($script:mode -ceq 'gui_timeout'){$script:now+=60000;return $false}
    if($script:mode -ceq 'gui_late_ready'){$script:now+=60001}
    return $true
}
$script:probeFailure=New-Object InvalidOperationException('Synthetic probe failure.')
$script:probeFailure.Data['overdrafter.native.childObservation']=[pscustomobject]@{exitCode=2}
function Invoke-PreparedLifecycle($Mode,$Label,$TimeoutMs,[switch]$AllowNotReady,$Journal){
    $script:probeCalls++
    Check ($Mode -ceq 'inspect' -and $AllowNotReady -and $TimeoutMs -ge 1 -and $TimeoutMs -le 30000) 'bounded inspection only'
    if($script:mode -ceq 'probe_error'){throw $script:probeFailure}
    if($script:mode -ceq 'late_ready'){$script:now+=60001;return $true}
    if($script:mode -ceq 'exact_deadline'){$script:now+=60000;return $true}
    if($script:mode -ceq 'just_in_time'){$script:now+=59999;return $true}
    if($script:mode -ceq 'not_ready'){$script:now+=$TimeoutMs;return $false}
    $script:now+=123;return $true
}
function Invoke-FixtureStartupDelay([int]$Milliseconds){$script:now+=$Milliseconds}
# Explicit script-local OS seam; this fixture never invokes the real cmdlet.
Set-Alias -Name 'Start-Sleep' -Value 'Invoke-FixtureStartupDelay' -Scope Script

function Invoke-StartupCase([string]$Mode){
    $script:mode=$Mode;$script:now=0;$script:probeCalls=0
    $script:supervisor=[ordered]@{}
    try{Wait-PreparedNativeReady -QualificationDelayedReadiness:($Mode -ceq 'injected_delay');return $null}catch{return $_.Exception}
}
# This must fail against the old coordinator, which returns immediately on true.
$failure=Invoke-StartupCase 'late_ready'
Check ($null -ne $failure -and $failure.Data['overdrafter.native.failureCode'] -ceq 'native_startup_timeout') 'late ready cannot admit operation'
$failure=Invoke-StartupCase 'exact_deadline'
Check ($null -ne $failure -and $failure.Data['overdrafter.native.failureCode'] -ceq 'native_startup_timeout') 'deadline boundary is expired'
$failure=Invoke-StartupCase 'just_in_time'
Check ($null -eq $failure -and $supervisor.startup.apiElapsedMs -eq 59999) 'ready within budget remains accepted'
$failure=Invoke-StartupCase 'injected_delay'
Check ($null -ne $failure -and $failure.Data['overdrafter.native.failureCode'] -ceq 'native_startup_timeout' -and
    $supervisor.startup.qualificationDelayedReadiness -and $supervisor.startup.apiElapsedMs -eq 60123) 'explicit injected admission delay reaches actual coordinator deadline'
Check ($supervisor.startup.probes[0].returnedMs -eq 123 -and $supervisor.startup.probes[0].finishedMs -eq 60123 -and
    $supervisor.startup.probes[0].injectedDelayMs -eq 60000) 'injected delay is separate from actual probe return time'
$source='a'*40; $jobHash='b'*64
$testJob=[pscustomobject]@{jobId='job';attemptId='attempt'}
$fault=[pscustomobject]@{jobId='job';attemptId='attempt';requestSha256=$jobHash;sourceCommit=$source;
    failureCode='native_startup_timeout';startup=(ConvertFrom-CompanionJson ($supervisor.startup | ConvertTo-Json -Depth 20))}
Assert-PreparedDelayedReadiness $fault $testJob $jobHash $source
Check $true 'actual coordinator evidence passes qualification validation'
foreach($change in @('scope','source','clock','duration','phase','label','native_late','delay_short','budget','missing_probe')){
    $bad=ConvertFrom-CompanionJson (ConvertTo-JournalJson $fault)
    switch($change){
        scope {$bad.attemptId='other'}
        source {$bad.sourceCommit='c'*40}
        clock {$bad.startup.apiElapsedMs='60123'}
        duration {$bad.startup.apiElapsedMs=59999}
        phase {$bad.startup.failureCode='process_uncertain'}
        label {$bad.startup.qualificationDelayedReadiness=$false}
        native_late {$bad.startup.probes[0].returnedMs=60000}
        delay_short {$bad.startup.probes[0].finishedMs=60122}
        budget {$bad.startup.probes[0].timeoutMs=30001}
        missing_probe {$bad.startup.probes=@()}
    }
    $denied=$false;try{Assert-PreparedDelayedReadiness $bad $testJob $jobHash $source}catch{$denied=$true}
    Check $denied ('invalid delayed-readiness evidence denied '+$change)
}
$failure=Invoke-StartupCase 'normal'
Check ($null -eq $failure -and $script:probeCalls -eq 1) 'timely ready accepted once'
Check ($supervisor.startup.outcome -ceq 'ready' -and $supervisor.startup.apiElapsedMs -eq 123 -and
    $supervisor.startup.probes.Count -eq 1 -and $supervisor.startup.probes[0].outcome -ceq 'ready') 'successful timing evidence retained'
$failure=Invoke-StartupCase 'not_ready'
Check ($null -ne $failure -and $failure.Data['overdrafter.native.failureCode'] -ceq 'native_startup_timeout' -and
    $script:now -eq 60000 -and $script:probeCalls -eq 2) 'not-ready waits exhaust fixed API budget'
Check ($supervisor.startup.probes[1].timeoutMs -eq 29000 -and $supervisor.startup.apiElapsedMs -eq 60000) 'probe timeout shrinks to remaining budget'
foreach($mode in @('gui_timeout','gui_late_ready')){
    $failure=Invoke-StartupCase $mode
    Check ($null -ne $failure -and $failure.Data['overdrafter.native.failureCode'] -ceq 'native_startup_timeout' -and
        $script:probeCalls -eq 0) ('GUI deadline blocks inspection '+$mode)
}
$failure=Invoke-StartupCase 'probe_error'
Check ([Object]::ReferenceEquals($failure,$script:probeFailure)) 'probe exception identity is preserved'
Check ($failure.Data['overdrafter.native.childObservation'].exitCode -eq 2 -and
    $supervisor.startup.failureCode -ceq 'unclassified' -and $supervisor.startup.probes[0].outcome -ceq 'error') 'probe failure does not become startup timeout'
$failure=Invoke-StartupCase 'gui_error'
# PowerShell wraps a ScriptMethod exception, as it wraps .NET method failures;
# the coordinator must preserve that observed failure rather than classify time.
Check ($failure.Message.Contains('Synthetic probe failure.') -and $script:probeCalls -eq 0 -and
    $supervisor.startup.failureCode -ceq 'unclassified') 'GUI observation error is not a timeout'
$script:probeFailure.Data['overdrafter.native.failureCode']='process_uncertain'
$failure=Invoke-StartupCase 'probe_error'
Check ([Object]::ReferenceEquals($failure,$script:probeFailure) -and $supervisor.startup.failureCode -ceq 'process_uncertain') 'typed process uncertainty remains unchanged'
[pscustomobject]@{schema='overdrafter.startup-deadline-tests.v1';passed=$true;assertions=$script:checks;
    nativeActions=0;clock='deterministic';processes='mocked'} | ConvertTo-Json -Compress
