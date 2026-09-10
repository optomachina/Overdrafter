#requires -Version 5.1
# Inert qualification-evidence cases; no storage or process execution.
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'QualificationEvidence.ps1')
. (Join-Path $PSScriptRoot 'test-contract.ps1')
$script:checks=0
function Add-TestProcess($Journal,[int]$Number,[string]$Role,[string]$Mode='') {
    $intent=Intent $Number $Role $null
    if ($Mode) { $intent.argumentsSha256=Get-JournalDigest (ConvertTo-JournalJson @($Mode,'303','639246383990000000','1')) }
    $next=Event $Journal launch_intent $intent
    $next=Event $next process_started (Started $Number ($Number+300))
    return Event $next process_exited (Exited $Number ($Number+300))
}
function New-TestQualification([bool]$IncludeClose=$true,[string]$CloseMode='graceful-close-empty') {
    $j=Add-TestProcess (New-NativeJournal $binding) 1 compiler
    $j=Add-TestProcess $j 2 compiler
    $j=Event $j launch_intent (Intent 3 native $null)
    $j=Event $j process_started (Started 3 303)
    $j=Event $j phase ([pscustomobject]@{phase='startup_wait'})
    $j=Add-TestProcess $j 4 lifecycle inspect
    $j=Add-TestProcess $j 5 lifecycle inspect
    $j=Event $j phase ([pscustomobject]@{phase='startup_ready'})
    $j=Event $j phase ([pscustomobject]@{phase='operation_started'})
    $j=Add-TestProcess $j 6 operation
    $j=Event $j phase ([pscustomobject]@{phase='operation_completed'})
    $j=Event $j phase ([pscustomobject]@{phase='outputs_saved'})
    if ($IncludeClose) { $j=Add-TestProcess $j 7 lifecycle $CloseMode }
    $j=Event $j process_exited (Exited 3 303)
    $text=ConvertTo-JournalJson $j; $digest=Get-JournalDigest $text
    return [pscustomobject]@{text=$text;sha256=$digest;supervisor=[pscustomobject]@{jobId=$binding.jobId;attemptId=$binding.attemptId;requestSha256=$binding.jobSha256;
        journal=[pscustomobject]@{sha256=$digest;headSha256=$j.headSha256;records=$j.records.Count;recordedProcessesExited=$true;recoveryRequired=$false}}}
}
$fixture=New-TestQualification
Check ((Assert-PreparedJournalEvidence $fixture.text $fixture.supervisor $binding $fixture.sha256).recordedProcessesExited) 'complete qualified record set'
foreach ($field in @('jobId','attemptId','requestSha256')) {
    Deny { $bad=Copy-JournalFixture $fixture.supervisor; $bad.$field=$null; Assert-PreparedJournalEvidence $fixture.text $bad $binding $fixture.sha256 } ('missing supervisor '+$field)
    Deny { $bad=Copy-JournalFixture $fixture.supervisor; $bad.$field=Id 999; Assert-PreparedJournalEvidence $fixture.text $bad $binding $fixture.sha256 } ('wrong supervisor '+$field)
}
foreach ($head in @($null,'',('f'*64))) { Deny { $bad=Copy-JournalFixture $fixture.supervisor; $bad.journal.headSha256=$head; Assert-PreparedJournalEvidence $fixture.text $bad $binding $fixture.sha256 } 'missing or stale supervisor checkpoint' }
Deny { $bad=Copy-JournalFixture $fixture.supervisor; $bad.journal.records=1; Assert-PreparedJournalEvidence $fixture.text $bad $binding $fixture.sha256 } 'supervisor count mismatch'
Deny { Assert-PreparedJournalEvidence $fixture.text $fixture.supervisor $binding ('f'*64) } 'artifact bytes mismatch'
$missing=New-TestQualification $false
Deny { Assert-PreparedJournalEvidence $missing.text $missing.supervisor $binding $missing.sha256 } 'two readiness probes cannot replace close'
$wrongMode=New-TestQualification $true inspect
Deny { Assert-PreparedJournalEvidence $wrongMode.text $wrongMode.supervisor $binding $wrongMode.sha256 } 'post-save readiness cannot impersonate close'
[pscustomobject]@{schema='overdrafter.journal-qualification-tests.v1';passed=$true;assertions=$script:checks;nativeActions=0} | ConvertTo-Json -Compress
