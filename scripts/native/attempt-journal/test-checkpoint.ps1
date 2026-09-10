#requires -Version 5.1
# Inert checkpoint/scope cases. Never starts a worker, native process or store.
$ErrorActionPreference='Stop'; Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot '../prepared-dimension/WireContract.ps1')
. (Join-Path $PSScriptRoot '../prepared-dimension/WireContractV2.ps1')
. (Join-Path $PSScriptRoot 'QualificationCheckpoint.ps1')
. (Join-Path $PSScriptRoot 'test-contract.ps1')
$script:checks=0
$owner=[pscustomobject]@{pid=42;creationTicks='639246383980000000';sessionId=1;executablePath='C:\Windows\powershell.exe'}
$base=New-NativeJournal $binding
foreach ($n in 1..2) {
    $base=Event $base launch_intent (Intent $n compiler $null)
    $base=Event $base process_started (Started $n (100+$n))
    $base=Event $base process_exited (Exited $n (100+$n))
}
$intent=Event $base launch_intent (Intent 3 native $null)
$identity=Event $intent process_started (Started 3 303)
$identity=Event $identity phase ([pscustomobject]@{phase='startup_wait'})
$saved=Event $identity phase ([pscustomobject]@{phase='startup_ready'})
$saved=Event $saved phase ([pscustomobject]@{phase='operation_started'})
$saved=Event $saved launch_intent (Intent 4 operation $null)
$saved=Event $saved process_started (Started 4 304)
$saved=Event $saved process_exited (Exited 4 304)
$saved=Event $saved phase ([pscustomobject]@{phase='operation_completed'})
$saved=Event $saved phase ([pscustomobject]@{phase='outputs_saved'})
$exited=Event $saved process_exited (Exited 3 303)
$deadline=Event $identity failure ([pscustomobject]@{code='native_startup_timeout';evidenceSha256=('e'*64)})
$boundaries=@{native_launch_intent=$intent;native_identity=$identity;outputs_saved=$saved;native_exit=$exited;startup_deadline=$deadline}
foreach ($boundary in $boundaries.Keys) {
    $checkpoint=New-PreparedQualificationCheckpoint $boundary $binding $boundaries[$boundary] $owner
    Assert-PreparedQualificationCheckpoint $checkpoint $boundary $binding
    Check ($checkpoint.journal.headSha256 -ceq $boundaries[$boundary].headSha256) ('exact checkpoint '+$boundary)
    Deny { $bad=Copy-JournalFixture $checkpoint; $bad.schema='other'; Assert-PreparedQualificationCheckpoint $bad $boundary $binding } ('checkpoint schema '+$boundary)
    foreach ($wrong in @($boundaries.Keys | Where-Object {$_ -cne $boundary})) {
        Deny { New-PreparedQualificationCheckpoint $boundary $binding $boundaries[$wrong] $owner } ('wrong phase '+$boundary+'/'+$wrong)
    }
}
Deny { New-PreparedQualificationCheckpoint unknown $binding $saved $owner } 'unknown checkpoint'
Deny { $bad=Copy-JournalFixture $binding; $bad.attemptId=Id 800; New-PreparedQualificationCheckpoint outputs_saved $bad $saved $owner } 'cross-attempt checkpoint'
Deny { $bad=Copy-JournalFixture $owner; $bad.pid=303; New-PreparedQualificationCheckpoint native_identity $binding $identity $bad } 'native cannot impersonate worker'
Deny { $bad=Copy-JournalFixture $owner; $bad.sessionId=2; New-PreparedQualificationCheckpoint native_identity $binding $identity $bad } 'native must share owner session'
Deny { $bad=Copy-JournalFixture $owner; $bad.creationTicks='639246383995000000'; New-PreparedQualificationCheckpoint native_identity $binding $identity $bad } 'native must follow owner creation'
$failed=Event $saved failure ([pscustomobject]@{code='native_operation_failed';evidenceSha256=('f'*64)})
Deny { New-PreparedQualificationCheckpoint outputs_saved $binding $failed $owner } 'failed history cannot qualify a pause'
Deny { New-PreparedQualificationCheckpoint startup_deadline $binding $failed $owner } 'operation failure cannot qualify startup timeout'
$job=Copy-JournalFixture ([pscustomobject]@{schema='overdrafter.prepared-dimension-job.v2';
    scope=[pscustomobject]@{organizationId=$binding.organizationId;projectId=$binding.projectId};jobId=$binding.jobId;attemptId=$binding.attemptId;
    fence=$binding.fence;inputSnapshotId=(Id 40);outputSnapshotId=(Id 41);seedSnapshotId=(Id 40);sequence=1;
    contextSha256=('a'*64);inputFiles=@($PreparedFiles | ForEach-Object {[pscustomobject]$_});expectedDepthMm=5;dimensionId='baseline-depth';depthMm=8;
    configuration='Default';createdAt='2026-09-10T12:00:00.000Z';requiredChecks=$PreparedChecks})
Assert-PreparedQualificationScope $job $binding ('a'*40); Check $true 'exact original synthetic job admitted'
foreach ($field in @('sequence','expectedDepthMm','depthMm')) {
    Deny { $bad=Copy-JournalFixture $job; $bad.$field=9; Assert-PreparedQualificationScope $bad $binding ('a'*40) } ('other operation scope '+$field)
}
Deny { $bad=Copy-JournalFixture $job; $bad.inputFiles[1].sha256=('f'*64); Assert-PreparedQualificationScope $bad $binding ('a'*40) } 'unqualified native inputs'
Deny { Assert-PreparedQualificationScope $job $null ('a'*40) } 'journal required'
Deny { Assert-PreparedQualificationScope $job $binding '' } 'source identity required'
Deny { & (Join-Path $PSScriptRoot 'qualify-worker-crash.ps1') -Boundary native_identity -PackageRoot unused -OutputRoot unused -OrganizationId $binding.organizationId -ProjectId $binding.projectId -SourceCommit ('a'*40) } 'controller default off'
$script:touched=$false
function Assert-NativeJournalStore { $script:touched=$true; throw 'Must not run at an unselected boundary.' }
Wait-PreparedQualificationCheckpoint native_identity outputs_saved unused $null
Check (-not $script:touched) 'unselected boundary performs no store or process action'
[pscustomobject]@{schema='overdrafter.worker-crash-checkpoint-tests.v1';passed=$true;assertions=$script:checks;nativeActions=0} | ConvertTo-Json -Compress
