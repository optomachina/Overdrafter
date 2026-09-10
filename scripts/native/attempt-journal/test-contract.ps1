#requires -Version 5.1
# Pure journal tests. No files, network, credentials or native processes.
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'JournalContract.ps1')
$script:checks=0
function Check([bool]$Value,[string]$Label) { $script:checks++; if (-not $Value) { throw ('Failed: '+$Label) } }
function Deny([scriptblock]$Action,[string]$Label) { $failed=$false; try { & $Action | Out-Null } catch { $failed=$true }; Check $failed $Label }
function Id([int]$Number) { return '00000000-0000-4000-8000-'+$Number.ToString('000000000000') }
function Copy-JournalFixture($Value) { return ConvertFrom-CompanionJson (ConvertTo-JournalJson $Value) }
function Event($Journal,[string]$Kind,$Data) { return Add-NativeJournalEvent $Journal $Kind $Data '2026-09-10T12:00:00.000Z' }
function Intent([int]$Number,[string]$Role,$Parent) { return [pscustomobject]@{launchId=(Id $Number);role=$Role;executablePath='C:\Native\tool.exe';executableSha256=('a'*64);workingDirectory='C:\Native\attempt';argumentsSha256=('b'*64);parentLaunchId=$Parent} }
function Started([int]$Number,[int]$ProcessId) { return [pscustomobject]@{launchId=(Id $Number);pid=$ProcessId;creationTicks='639246383990000000';sessionId=1;executablePath='C:\Native\tool.exe';executableSha256=('a'*64)} }
function Exited([int]$Number,[int]$ProcessId) { return [pscustomobject]@{launchId=(Id $Number);pid=$ProcessId;creationTicks='639246383990000000';sessionId=1;exitCode=0;terminationRequested=$false} }
$binding=[pscustomobject]@{organizationId=(Id 1);projectId=(Id 2);workerId=(Id 3);installationId=(Id 4);bootId=(Id 5);taskId=(Id 6);attemptId=(Id 7);jobId=(Id 8);fence=1;jobSha256=('c'*64);runtimeAdmissionId=(Id 9)}
$empty=New-NativeJournal $binding
Check (-not (Get-NativeJournalSummary $empty).recordedProcessesExited) 'empty history is not stop proof'
Check (-not (Get-NativeJournalSummary $empty).stopAdmission) 'no server authority'
Check ((Get-JournalDigest 'abc') -ceq 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad') 'standard SHA256 vector'
Check ((ConvertTo-JournalJson ([pscustomobject]@{z="a`n";a=('quote"\'+[char]0x00e9)})) -ceq '{"a":"quote\"\\\u00e9","z":"a\u000a"}') 'canonical encoding is stable'
$journal=Event $empty launch_intent (Intent 10 compiler $null)
Check ($empty.records.Count -eq 0) 'append does not mutate input'
Check ((Get-NativeJournalSummary $journal).recoveryRequired) 'intent-only gap needs recovery'
Deny { Event $journal process_exited (Exited 10 100) } 'absence cannot replace creation'
Deny { Event $journal launch_intent (Intent 11 compiler $null) } 'unresolved compiler prevents next launch'
foreach ($field in @('executablePath','executableSha256')) {
    Deny { $bad=Started 10 100; $bad.$field=@(); Event $journal process_started $bad } ('empty array creation '+$field)
    Deny { $bad=Started 10 100; $bad.$field=@($bad.$field); Event $journal process_started $bad } ('array creation '+$field)
    Deny { $bad=Started 10 100; $bad.$field=$null; Event $journal process_started $bad } ('null creation '+$field)
}
$journal=Event $journal process_started (Started 10 100)
$journal=Event $journal process_exited (Exited 10 100)
Check ((Get-NativeJournalSummary $journal).recordedProcessesExited) 'recorded compiler has exact exit'
Deny { Event $journal process_exited (Exited 10 100) } 'duplicate exit refused'
$journal=Event $journal launch_intent (Intent 11 native $null)
$journal=Event $journal process_started (Started 11 101)
$journal=Event $journal phase ([pscustomobject]@{phase='startup_wait'})
$startup=Copy-JournalFixture $journal
$timeout=Event $startup failure ([pscustomobject]@{code='native_startup_timeout';evidenceSha256=('d'*64)})
Check ((Get-NativeJournalSummary $timeout).failureCode -ceq 'native_startup_timeout') 'typed pre-operation timeout'
Check (-not (Get-NativeJournalSummary $timeout).retryAuthorized) 'timeout does not authorize retry'
Deny { Event $timeout phase ([pscustomobject]@{phase='startup_ready'}) } 'failure cannot resume execution'
$timeout=Event $timeout process_exited (Exited 11 101)
Check ((Get-NativeJournalSummary $timeout).recordedProcessesExited) 'failure and observed stop remain separate'
$journal=Event $journal phase ([pscustomobject]@{phase='startup_ready'})
Deny { Event $journal failure ([pscustomobject]@{code='native_startup_timeout';evidenceSha256=('d'*64)}) } 'post-startup failure not transient'
Deny { Event $journal launch_intent (Intent 12 operation $null) } 'operation intent needs its phase'
$journal=Event $journal phase ([pscustomobject]@{phase='operation_started'})
Deny { Event $journal phase ([pscustomobject]@{phase='operation_completed'}) } 'completion needs actual helper exit'
Deny { Event $journal launch_intent (Intent 12 operation (Id 11)) } 'COM target is not an OS parent'
$journal=Event $journal launch_intent (Intent 12 operation $null)
$journal=Event $journal process_started (Started 12 102)
Deny { $exit=Exited 12 102; $exit.creationTicks='639246383990000001'; Event $journal process_exited $exit } 'PID reuse ticks denied'
Deny { $exit=Exited 12 102; $exit.sessionId=2; Event $journal process_exited $exit } 'wrong session denied'
$journal=Event $journal process_exited (Exited 12 102)
Deny { Event $journal launch_intent (Intent 13 operation $null) } 'operation never repeats in same attempt'
$journal=Event $journal phase ([pscustomobject]@{phase='operation_completed'})
$journal=Event $journal phase ([pscustomobject]@{phase='outputs_saved'})
$journal=Event $journal process_exited (Exited 11 101)
Check ((Get-NativeJournalSummary $journal).recordedProcessesExited) 'all recorded processes exited'
Check (-not (Get-NativeJournalSummary $journal).recoveryRequired) 'no unresolved recorded processes'
$wire=ConvertTo-JournalJson $journal
Check ((Read-NativeJournalText $wire $journal.headSha256).headSha256 -ceq $journal.headSha256) 'canonical roundtrip/checkpoint'
foreach ($key in @('organizationId','projectId','workerId','installationId','bootId','taskId','attemptId','jobId','runtimeAdmissionId')) {
    Deny { $bad=Copy-JournalFixture $journal; $bad.binding.$key=Id 999; Get-NativeJournalSummary $bad } ('binding '+$key)
}
foreach ($badValue in @(-1,0,1.5,'1',$true)) { Deny { $bad=Copy-JournalFixture $binding; $bad.fence=$badValue; New-NativeJournal $bad } 'invalid fence' }
foreach ($path in @('\\server\share','C:\Native\..\else','C:\Native\a:ads','C:\Native\\double','C:\Native\trailing.','/tmp/native')) { Deny { Assert-JournalPath $path } ('bad path '+$path) }
Deny { $bad=Copy-JournalFixture $journal; $bad.records[1].data.pid=999; Get-NativeJournalSummary $bad } 'altered process'
Deny { $bad=Copy-JournalFixture $journal; $bad.records[0].sequence=2; Get-NativeJournalSummary $bad } 'wrong sequence'
Deny { $bad=Copy-JournalFixture $journal; $bad.records[0].previousSha256=@($bad.records[0].previousSha256); Get-NativeJournalSummary $bad } 'array cannot impersonate a digest'
Deny { $bad=Copy-JournalFixture $journal; $bad.records=$bad.records[1..($bad.records.Count-1)]; Get-NativeJournalSummary $bad } 'omitted record'
Deny { $bad=Copy-JournalFixture $journal; [Array]::Reverse($bad.records); Get-NativeJournalSummary $bad } 'reordered history'
Deny { $bad=Copy-JournalFixture $journal; $bad | Add-Member x 1; Get-NativeJournalSummary $bad } 'extra authority field'
Deny { Read-NativeJournalText ($wire+' ') } 'noncanonical trailing text'
Deny { Read-NativeJournalText ('{"schema":"bogus",'+$wire.Substring(1)) } 'duplicate keys'
Deny { Read-NativeJournalText $wire.Substring(0,$wire.Length-1) } 'truncated bytes'
Deny { Read-NativeJournalText (' '*2000001) } 'oversized wire'
Deny { $nested=1; for($i=0;$i -lt 14;$i++) { $nested=[pscustomobject]@{child=$nested} }; ConvertTo-JournalJson $nested } 'excessive nesting rejected'
foreach($field in @('workerId','jobSha256')) { Deny { $bad=Copy-JournalFixture $binding; $bad.$field+="`n"; New-NativeJournal $bad } 'trailing newline in bound identity' }
Deny { Read-NativeJournalText (ConvertTo-JournalJson $startup) $journal.headSha256 } 'old valid prefix mismatches acknowledged head'
Deny { Add-NativeJournalEvent $journal uncertain ([pscustomobject]@{reason='unknown_child'}) '2026-09-10T11:59:59.000Z' } 'backwards observation time'
$unknown=Event $journal uncertain ([pscustomobject]@{reason='unknown_child'})
Check ((Get-NativeJournalSummary $unknown).recoveryRequired -and -not (Get-NativeJournalSummary $unknown).recordedProcessesExited) 'unknown child defeats complete known exits'
Deny { Event $unknown launch_intent (Intent 40 compiler $null) } 'uncertain history cannot launch'
foreach ($code in @('input_invalid','runtime_mismatch','native_operation_failed','artifact_invalid','deadline_exceeded','authority_lost','process_uncertain','unclassified')) {
    $failed=Event $startup failure ([pscustomobject]@{code=$code;evidenceSha256=('e'*64)})
    Check ((Get-NativeJournalSummary $failed).failureCode -ceq $code -and -not (Get-NativeJournalSummary $failed).retryAuthorized) ('failure '+$code)
}
[pscustomobject]@{schema='overdrafter.journal-contract-tests.v1';passed=$true;assertions=$script:checks;nativeActions=0} | ConvertTo-Json -Compress
