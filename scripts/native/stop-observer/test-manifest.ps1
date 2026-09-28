#requires -Version 5.1
param([switch]$WriteFixtures)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'Manifest.ps1')
$script:checks=0
function Check($Value,$Label) { $script:checks++; if (-not $Value) { throw ('Failed: '+$Label) } }
function Deny($Action,$Label) { $failed=$false; try { & $Action | Out-Null } catch { $failed=$true }; Check $failed $Label }
function Copy-StopFixture($Value) { return ConvertFrom-CompanionJson (ConvertTo-JournalJson $Value) }
function Id([int]$Number) { return '00000000-0000-4000-8000-'+$Number.ToString('000000000000') }
$binding=[pscustomobject]@{organizationId=(Id 1);projectId=(Id 2);workerId=(Id 3);installationId=(Id 4);bootId=(Id 5);
    taskId=(Id 6);attemptId=(Id 7);jobId=(Id 8);fence=1;jobSha256=('c'*64);runtimeAdmissionId=(Id 9)}
$request=[pscustomobject]@{binding=$binding;contextSha256=('d'*64);deadline='2026-09-27T12:05:00.000Z';observerRunId=(Id 90)}
$journal=New-NativeJournal $binding
function AddEvent($Kind,$Data) { $script:journal=Add-NativeJournalEvent $script:journal $Kind $Data '2026-09-27T12:00:02.000Z' }
$processes=@(); $ticks=[DateTime]::Parse('2026-09-27T12:00:01Z').ToUniversalTime().Ticks.ToString()
foreach ($number in @(10,11,12,13)) {
    $role=@{10='compiler';11='native';12='lifecycle';13='operation'}[$number]
    if ($number -eq 13) { AddEvent phase ([pscustomobject]@{phase='operation_started'}) }
    AddEvent launch_intent ([pscustomobject]@{launchId=(Id $number);role=$role;executablePath='C:\Fixture\tool.exe';
        executableSha256=('a'*64);workingDirectory='C:\Fixture';argumentsSha256=('b'*64);parentLaunchId=$null})
    AddEvent process_started ([pscustomobject]@{launchId=(Id $number);pid=$number;creationTicks=$ticks;sessionId=1;executablePath='C:\Fixture\tool.exe';executableSha256=('a'*64)})
    if ($role -eq 'native') { AddEvent phase ([pscustomobject]@{phase='startup_wait'}); AddEvent phase ([pscustomobject]@{phase='startup_ready'}) }
    else { AddEvent process_exited ([pscustomobject]@{launchId=(Id $number);pid=$number;creationTicks=$ticks;sessionId=1;exitCode=0;terminationRequested=$false}) }
    $processes+=@([pscustomobject]@{identity=[pscustomobject]@{pid=$number;creationTicks=$ticks;sessionId=1;executablePath='C:\Fixture\tool.exe'};
        executableSha256=('a'*64);parentPid=100;observedAt='2026-09-27T12:00:01.001Z';exitCode=0;exitedAt='2026-09-27T12:00:02.000Z'})
}
AddEvent phase ([pscustomobject]@{phase='operation_completed'}); AddEvent phase ([pscustomobject]@{phase='outputs_saved'})
AddEvent process_exited ([pscustomobject]@{launchId=(Id 11);pid=11;creationTicks=$ticks;sessionId=1;exitCode=0;terminationRequested=$false})
$root=Copy-StopFixture $processes[0]; $root.identity.pid=100; $root.parentPid=0; $root.exitedAt='2026-09-27T12:00:03.000Z'
$observation=[pscustomobject]@{startedAt='2026-09-27T12:00:00.000Z';observedAt='2026-09-27T12:00:04.000Z';root=$root;processes=$processes;
    totalProcesses=5;activeProcesses=0;limitedProcesses=0}
$wire=ConvertTo-JournalJson $journal
$text=New-StopManifest $request $wire $observation; $manifest=ConvertFrom-CompanionJson $text
Check ($manifest.terminalProcesses.Count -eq 4 -and $manifest.executionOutcome -ceq 'native_exit_succeeded') 'all four roles map to independent exits'
Check (-not $manifest.stopAdmission -and -not $manifest.nativeQualification) 'no admission or native qualification'
Check ($manifest.journalSha256 -ceq (Get-JournalDigest $wire)) 'exact journal bytes bound'
Check ($text -ceq (New-StopManifest (Copy-StopFixture $request) $wire (Copy-StopFixture $observation))) 'canonical output stable'
foreach ($scenario in @('missed_child','unknown_child','nested_child','pid_reuse','identity_ticks','identity_session','identity_image','identity_hash','missing_exit','wrong_exit','active_job','limited_job','root_missing_exit','late','clock_reversal','observer_loss','worker_complete')) {
    $bad=Copy-StopFixture $observation
    switch ($scenario) {
        missed_child { $bad.totalProcesses=6 }
        unknown_child { $extra=Copy-StopFixture $bad.processes[0]; $extra.identity.pid=99; $bad.processes+=@($extra); $bad.totalProcesses++ }
        nested_child { $bad.processes[0].parentPid=11 }
        pid_reuse { $bad.processes[1].identity.pid=10 }
        identity_ticks { $bad.processes[0].identity.creationTicks=([long]$ticks+1).ToString() }
        identity_session { $bad.processes[0].identity.sessionId=2 }
        identity_image { $bad.processes[0].identity.executablePath='C:\Other\tool.exe' }
        identity_hash { $bad.processes[0].executableSha256='e'*64 }
        missing_exit { $bad.processes[0].exitCode=$null }
        wrong_exit { $bad.processes[0].exitCode=1 }
        active_job { $bad.activeProcesses=1 }
        limited_job { $bad.limitedProcesses=1 }
        root_missing_exit { $bad.root.exitedAt=$null }
        late { $bad.observedAt=$request.deadline }
        clock_reversal { $bad.observedAt='2026-09-27T11:59:59.000Z' }
        observer_loss { $bad=$null }
        worker_complete { $bad | Add-Member -NotePropertyName processBoundaryComplete -NotePropertyValue $true; $bad.processes=@() }
    }
    Deny { New-StopManifest $request $wire $bad } $scenario
}
# A structurally valid prefix with a durable intent but no creation stays denied.
$gap=New-NativeJournal $binding
$gap=Add-NativeJournalEvent $gap launch_intent $journal.records[0].data '2026-09-27T12:00:02.000Z'
Deny { New-StopManifest $request (ConvertTo-JournalJson $gap) $observation } 'ambiguous launch'
$uncertain=Add-NativeJournalEvent $journal uncertain ([pscustomobject]@{reason='unknown_child'}) '2026-09-27T12:00:02.000Z'
Deny { New-StopManifest $request (ConvertTo-JournalJson $uncertain) $observation } 'worker uncertainty cannot be healed by count'
foreach ($field in @('attemptId','bootId','jobId','workerId','installationId','runtimeAdmissionId')) {
    $bad=Copy-StopFixture $request; $bad.binding.$field=Id 999
    Deny { New-StopManifest $bad $wire $observation } ('foreign '+$field)
}
Deny { $bad=Copy-StopFixture $request; $bad.binding.fence++; New-StopManifest $bad $wire $observation } 'foreign fence'
Deny { $bad=Copy-StopFixture $request; $bad.binding.jobSha256='f'*64; New-StopManifest $bad $wire $observation } 'foreign job bytes'
Deny { New-StopManifest $request ($wire+' ') $observation } 'noncanonical journal'
# No worker completeness field is read or admitted in either input.
Deny { $bad=Copy-StopFixture $journal; $bad | Add-Member -NotePropertyName complete -NotePropertyValue $true; New-StopManifest $request (ConvertTo-JournalJson $bad) $observation } 'worker complete flag rejected'
. (Join-Path $PSScriptRoot 'Observer.ps1')
Deny { Invoke-IndependentStopObserver } 'default off before arguments/platform/effects'
$state=[pscustomobject]@{failed=$true;clock=[pscustomobject]@{ElapsedMilliseconds=0};budget=100;deadline=[DateTimeOffset]::UtcNow.AddMinutes(1)}
Deny { Assert-StopBudget $state } 'permanent observer failure'
$state.failed=$false; $state.clock.ElapsedMilliseconds=100
Deny { Assert-StopBudget $state } 'monotonic deadline'
$state.clock.ElapsedMilliseconds=0
Deny { Assert-StopBudget $state } 'expired observation cannot recover'
if ($WriteFixtures) {
    foreach ($entry in @(@('request.json',(ConvertTo-JournalJson $request)),@('journal.json',$wire),@('observation.json',(ConvertTo-JournalJson $observation)),@('manifest.json',$text))) {
        [IO.File]::WriteAllText((Join-Path $PSScriptRoot ('fixtures/'+$entry[0])),$entry[1],(New-Object Text.UTF8Encoding($false)))
    }
} else {
    Check ([IO.File]::ReadAllText((Join-Path $PSScriptRoot 'fixtures/manifest.json')) -ceq $text) 'published fixture exact bytes'
}
[pscustomobject]@{schema='overdrafter.stop-observer-contract-tests.v1';passed=$true;assertions=$script:checks;nativeActions=0;processes='synthetic records'} | ConvertTo-Json -Compress
