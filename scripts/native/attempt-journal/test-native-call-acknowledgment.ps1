#requires -Version 5.1
# Real temporary checkpoint files, synthetic journal and mocked owner/store.
$ErrorActionPreference='Stop'; Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'test-native-call.ps1')
. (Join-Path $PSScriptRoot 'NativeCallAcknowledgment.ps1')
. (Join-Path $PSScriptRoot 'QualificationEvidence.ps1')
$script:checks=0
function Assert-NativeJournalStore($Store) { if ($Store.poisoned) { throw 'Synthetic failed store.' } }
function Get-RunnerProcessIdentity { return $owner }
function Get-PreparedHash { return 'a'*64 }
$session=[pscustomobject]@{journal=$interrupted;store=[pscustomobject]@{poisoned=$false;
    head=$interrupted.headSha256;count=$interrupted.records.Count;statePath='unused'}}
$launch=[pscustomobject]@{intent=$helperIntent;identity=$helperStarted}
$root=Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid().ToString())
[void][IO.Directory]::CreateDirectory($root)
try {
    Write-NativeCallAcknowledgment $session $launch $settings $root
    $path=Join-Path $root 'native-call-acknowledged.json'
    $ack=Read-PreparedJournalSupervisor $path
    Assert-NativeCallAcknowledgment $ack $receipt $binding $owner
    Check ((ConvertTo-JournalJson $ack.journal) -ceq (ConvertTo-JournalJson $interrupted)) 'atomic checkpoint preserves exact acknowledged history'
    Check (-not [IO.File]::Exists((Join-Path $root 'native-call-acknowledged.pending'))) 'pending checkpoint is absent after atomic publication'
    $before=[IO.File]::ReadAllText($path)
    Deny { Write-NativeCallAcknowledgment $session $launch $settings $root } 'cannot overwrite existing acknowledgment'
    Check ([IO.File]::ReadAllText($path) -ceq $before) 'failed publication preserves original checkpoint'
    foreach ($field in @('schema','sourceCommit','nonce','boundary','cipherSha256')) {
        Deny { $bad=Copy-JournalFixture $ack; $bad.$field='foreign'; Assert-NativeCallAcknowledgment $bad $receipt $binding $owner } ('reject changed acknowledgment '+$field)
        Deny { $bad=Copy-JournalFixture $ack; $bad.$field=@($bad.$field); Assert-NativeCallAcknowledgment $bad $receipt $binding $owner } ('reject array acknowledgment '+$field)
    }
    Deny { $bad=Copy-JournalFixture $ack; $bad.owner.pid++; Assert-NativeCallAcknowledgment $bad $receipt $binding $owner } 'foreign owner is rejected'
    Deny { $bad=Copy-JournalFixture $ack; $bad.journal=$saved; Assert-NativeCallAcknowledgment $bad $receipt $binding $owner } 'another journal cannot acknowledge active call'
    Deny { $bad=Copy-JournalFixture $ack; $bad | Add-Member retryAuthorized $true; Assert-NativeCallAcknowledgment $bad $receipt $binding $owner } 'acknowledgment never grants authority'
    foreach ($scenario in @('poisoned','head','count','missing_creation','wrong_launch','missing_identity','wrong_role')) {
        $copy=Copy-JournalFixture $session; $child=Copy-JournalFixture $launch
        switch ($scenario) {
            poisoned { $copy.store.poisoned=$true }
            head { $copy.store.head='b'*64 }
            count { $copy.store.count-- }
            missing_creation { $copy.journal.records=@($copy.journal.records | Select-Object -SkipLast 1) }
            wrong_launch { $child.intent.launchId=[Guid]::NewGuid().ToString() }
            missing_identity { $child.identity=$null }
            wrong_role { $child.intent.role='compiler' }
        }
        $fresh=Join-Path $root $scenario; [void][IO.Directory]::CreateDirectory($fresh)
        Deny { Write-NativeCallAcknowledgment $copy $child $settings $fresh } ('cannot publish unacknowledged history '+$scenario)
        Check (@([IO.Directory]::GetFiles($fresh)).Count -eq 0) ('failed acknowledgment writes nothing '+$scenario)
    }
    # Exercise the actual runner's observer closure with real checkpoint writes.
    # The inert child seam stops immediately after capture, before native output.
    $tokens=$null; $errors=$null
    $ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot '../prepared-dimension/run.ps1'),[ref]$tokens,[ref]$errors)
    $function=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Invoke-PreparedOperation'},$true)
    . ([scriptblock]::Create($function.Extent.Text))
    function Assert-PreparedNativeIdentity {}
    function Save-PreparedProgress {}
    function Invoke-RunnerJournalChild($Session,$Role,$Executable,$Arguments,$TimeoutMs,$LogBase,[scriptblock]$CreationAcknowledged) {
        & $CreationAcknowledged $Session $launch
        throw 'Synthetic stop after actual operation acknowledgment.'
    }
    function Invoke-PreparedChild { throw 'Synthetic ordinary operation dispatch.' }
    $supervisor=@{stage='';native=@{pid=1;ticks='1';session=1};binaries=@{PreparedDimensionProbe=('a'*64)}}
    $operationHelper='unused'; $journalSession=$session
    foreach ($qualified in @($true,$false)) {
        $qualifyNativeCall=$qualified; $folder=Join-Path $root ('dispatch-'+$qualified)
        [void][IO.Directory]::CreateDirectory($folder)
        $failure=$null
        try { Invoke-PreparedOperation } catch { $failure=$_.Exception.Message }
        if ($qualified) {
            Check ($failure -ceq 'Synthetic stop after actual operation acknowledgment.') 'qualified runner closure publishes before returning child observation'
            $actual=Read-PreparedJournalSupervisor (Join-Path $folder 'native-call-acknowledged.json')
            Assert-NativeCallAcknowledgment $actual $receipt $binding $owner
        } else {
            Check ($failure -ceq 'Synthetic ordinary operation dispatch.' -and @([IO.Directory]::GetFiles($folder)).Count -eq 0) 'ordinary runner emits no qualification acknowledgment'
        }
    }
} finally { [IO.Directory]::Delete($root,$true) }
[pscustomobject]@{schema='overdrafter.native-call-acknowledgment-tests.v1';passed=$true;assertions=$script:checks;
    nativeActions=0;processes='mocked';journalStore='mocked';checkpointFiles='real temporary files'} | ConvertTo-Json -Compress
