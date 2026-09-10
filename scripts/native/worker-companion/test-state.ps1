#requires -Version 5.1
# In-memory protocol/fault tests only: no DPAPI, network, files or CAD actions.
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'CompanionState.ps1')
$script:assertions=0
function Check([bool]$Condition,[string]$Label) {
    $script:assertions++
    if (-not $Condition) { throw ('Assertion failed: '+$Label) }
}
function Must-Fail([scriptblock]$Operation,[string]$Label) {
    $failed=$false
    try { & $Operation | Out-Null } catch { $failed=$true }
    Check $failed $Label
}
function New-Fixture {
    $state=New-CompanionState ([Guid]::NewGuid().ToString()) 'https://example.invalid/functions/v1/engineering-worker' (New-CompanionSecret pairing)
    $script:disk=Copy-CompanionRecord $state
    $script:server=@{revision=1;boot=$null;paired=$false;enabled=$false;events=@{};drop=$null;calls=@();token=$state.token;installation=$state.installationId;worker=$state.workerId;conflicts=0}
    return $state
}
$writeFixture={param($state) Assert-CompanionState $state; $script:disk=Copy-CompanionRecord $state}
$transport={param($request,$token,$endpoint)
    Check ($token -ceq $script:server.token) 'same raw token retained'
    Check ($endpoint -ceq 'https://example.invalid/functions/v1/engineering-worker') 'pinned gateway'
    $script:server.calls+=Copy-CompanionRecord $request
    if ($request.action -ceq 'session') {
        $reason='boot_mismatch'
        if ($request.bootId -ceq $script:server.boot) { $reason='owner_enablement_required' }
        $receipt=[pscustomobject]@{workerId=$script:server.worker;installationId=$script:server.installation;bootId=$script:server.boot;
            revision=$script:server.revision;sessionId=$null;expiresAt=$null;sessionEligible=$false;reason=$reason}
    } else {
        Check (($script:disk.pending | ConvertTo-Json -Compress) -ceq ($request | ConvertTo-Json -Compress)) 'pending request persisted before transport'
        if ($script:server.events.ContainsKey($request.idempotencyKey)) { $receipt=Copy-CompanionRecord $script:server.events[$request.idempotencyKey] }
        else {
            if ($request.action -ceq 'boot' -and $script:server.conflicts -gt 0) {
                $script:server.conflicts--; $script:server.revision++
                return [pscustomobject]@{status=409;body=[pscustomobject]@{schema='overdrafter.worker-gateway.v1';error='worker_conflict';outcome='not_applied';retrySameRequest=$false}}
            }
            Check ($request.expectedRevision -eq $script:server.revision) 'fresh mutation revision'
            $script:server.revision++
            if ($request.action -ceq 'pair') {
                $script:server.paired=$true
                $receipt=[pscustomobject]@{workerId=$script:server.worker;installationId=$script:server.installation;revision=$script:server.revision;pairedAt='2026-09-10T00:00:00Z'}
            } else {
                $script:server.boot=$request.bootId; $script:server.enabled=$false
                $receipt=[pscustomobject]@{workerId=$script:server.worker;bootId=$request.bootId;revision=$script:server.revision;enabled=$false}
            }
            $script:server.events[$request.idempotencyKey]=Copy-CompanionRecord $receipt
        }
        if ($script:server.drop -ceq $request.action) { $script:server.drop=$null; throw 'Synthetic lost response with hidden transport details.' }
    }
    return [pscustomobject]@{status=200;body=[pscustomobject]@{schema='overdrafter.worker-gateway.v1';action=$request.action;receipt=$receipt}}
}
$state=New-Fixture; $run=[Guid]::NewGuid().ToString()
$ready=Invoke-CompanionStartup $state $run $transport $writeFixture
Check ($ready.paired -and $ready.bootId -ceq $run -and $null -eq $ready.pending) 'initial pair and boot complete'
Check (-not $state.paired -and $state.revision -eq 1) 'caller input is not mutated'
Check ($script:server.events.Count -eq 2) 'one pairing and one boot effect'
Check (($script:disk | ConvertTo-Json -Depth 20) -cnotmatch 'pairingCode') 'pairing code removed only after durable receipt'
# New process observes an owner-updated revision and always registers a new boot.
$script:server.revision++; $script:server.enabled=$true
$newRun=[Guid]::NewGuid().ToString()
$ready=Invoke-CompanionStartup $script:disk $newRun $transport $writeFixture
Check ($ready.bootId -ceq $newRun -and -not $script:server.enabled) 'restart does not inherit old enablement'
Check ($script:server.events.Count -eq 3) 'restart adds exactly one boot'
# Lost pairing response: durable initial request and token survive to a new run.
$state=New-Fixture; $pairJson=$state.pending | ConvertTo-Json -Compress; $script:server.drop='pair'
Must-Fail { Invoke-CompanionStartup $state ([Guid]::NewGuid().ToString()) $transport $writeFixture } 'lost pair fails finitely'
Check (($script:disk.pending | ConvertTo-Json -Compress) -ceq $pairJson) 'lost pair retains exact request'
$ready=Invoke-CompanionStartup $script:disk ([Guid]::NewGuid().ToString()) $transport $writeFixture
Check ($ready.paired -and $script:server.events.Count -eq 2) 'pair replay creates no duplicate effect'
# Lost boot response: reconcile its receipt, then register this new process's boot.
$state=New-Fixture; $oldRun=[Guid]::NewGuid().ToString(); $script:server.drop='boot'
Must-Fail { Invoke-CompanionStartup $state $oldRun $transport $writeFixture } 'lost boot fails finitely'
$oldRequest=$script:disk.pending | ConvertTo-Json -Compress
$script:server.enabled=$true; $script:server.revision++
$newRun=[Guid]::NewGuid().ToString(); $ready=Invoke-CompanionStartup $script:disk $newRun $transport $writeFixture
$bootCalls=@($script:server.calls | Where-Object action -CEQ 'boot')
Check (($bootCalls[1] | ConvertTo-Json -Compress) -ceq $oldRequest) 'old boot replay keeps exact key and revision'
Check ($ready.bootId -ceq $newRun -and -not $script:server.enabled) 'recovered old boot never enables new process'
Check ($script:server.events.Count -eq 3) 'only pair, recovered boot and new boot effects'
# A confirmed refusal may refresh once; uncertainty may never rotate the key.
$state=New-Fixture; $script:server.conflicts=1
$ready=Invoke-CompanionStartup $state ([Guid]::NewGuid().ToString()) $transport $writeFixture
Check ($ready.paired -and $script:server.events.Count -eq 2) 'one explicit revision conflict recovers'
$state=New-Fixture; $script:server.conflicts=2
Must-Fail { Invoke-CompanionStartup $state ([Guid]::NewGuid().ToString()) $transport $writeFixture } 'repeated conflicts are bounded'
# A disk failure before the boot send prevents that external mutation.
$state=New-Fixture
$failPersist={param($value) if ($value.pending -and $value.pending.action -ceq 'boot') { throw 'Synthetic disk failure.' }; & $writeFixture $value}
Must-Fail { Invoke-CompanionStartup $state ([Guid]::NewGuid().ToString()) $transport $failPersist } 'disk failure stops startup'
Check ($script:server.events.Count -eq 1) 'no boot sent before durable pending record'
$ready=Invoke-CompanionStartup $script:disk ([Guid]::NewGuid().ToString()) $transport $writeFixture
Check ($script:server.events.Count -eq 2) 'disk recovery reuses paired identity'
# Unknown/refused/contradictory responses preserve the pending operation.
foreach ($status in @(401,403,500,502,503,504)) {
    $state=New-Fixture; $saved=$script:disk | ConvertTo-Json -Depth 20 -Compress
    $refusal={param($request,$token,$endpoint) return [pscustomobject]@{status=$status;body=[pscustomobject]@{secret='must not be reflected'}}}
    Must-Fail { Invoke-CompanionStartup $state ([Guid]::NewGuid().ToString()) $refusal $writeFixture } ('refusal '+$status)
    Check (($script:disk | ConvertTo-Json -Depth 20 -Compress) -ceq $saved) 'refusal retains pending state'
}
foreach ($mutation in @('extra','token','endpoint','revision','pendingWorker','pairingCode','unpairedBoot','schemaArray','actionArray','workerArray')) {
    $state=New-Fixture
    switch ($mutation) {
        'extra' { $state | Add-Member extra 'forbidden' }
        'token' { $state.token='odp_'+('a'*64) }
        'endpoint' { $state.gatewayUrl='http://example.invalid/functions/v1/engineering-worker' }
        'revision' { $state.revision=1.5 }
        'pendingWorker' { $state.pending.workerId=[Guid]::NewGuid().ToString() }
        'pairingCode' { $state.pending.pairingCode=$state.token }
        'unpairedBoot' { $state.bootId=[Guid]::NewGuid().ToString() }
        'schemaArray' { $state.schema=@() }
        'actionArray' { $state.pending.action=@() }
        'workerArray' { $state.pending.workerId=@() }
    }
    Must-Fail { Invoke-CompanionStartup $state ([Guid]::NewGuid().ToString()) $transport $writeFixture } ('corrupt state '+$mutation)
    Check ($script:server.calls.Count -eq 0) 'corruption denied before transport'
}
# A valid server mutation with a malformed/lost local receipt stays replayable.
$fixtureTransport=$transport
foreach ($mutation in @('worker','installation','revision','timestamp','extra','action','workerArray','schemaArray')) {
    $state=New-Fixture
    $badReply={param($request,$token,$endpoint)
        $reply=& $fixtureTransport $request $token $endpoint
        switch ($mutation) {
            'worker' { $reply.body.receipt.workerId=[Guid]::NewGuid().ToString() }
            'installation' { $reply.body.receipt.installationId=[Guid]::NewGuid().ToString() }
            'revision' { $reply.body.receipt.revision++ }
            'timestamp' { $reply.body.receipt.pairedAt='2026-99-99T12:00:00Z' }
            'extra' { $reply.body.receipt | Add-Member rawSecret 'must not be accepted' }
            'action' { $reply.body.action='boot' }
            'workerArray' { $reply.body.receipt.workerId=@() }
            'schemaArray' { $reply.body.schema=@() }
        }
        return $reply
    }
    Must-Fail { Invoke-CompanionStartup $state ([Guid]::NewGuid().ToString()) $badReply $writeFixture } ('bad receipt '+$mutation)
    Check (-not $script:disk.paired -and $script:disk.pending.action -ceq 'pair') 'bad receipt preserves pairing journal'
    $ready=Invoke-CompanionStartup $script:disk ([Guid]::NewGuid().ToString()) $transport $writeFixture
    Check ($ready.paired -and $script:server.events.Count -eq 2) 'bad receipt recovery replays original mutation'
}
$state=New-Fixture; $oldRun=[Guid]::NewGuid().ToString()
$failReceiptSave={param($value)
    if ($value.bootId -and -not $value.pending) { throw 'Synthetic lost receipt persistence.' }
    & $writeFixture $value
}
Must-Fail { Invoke-CompanionStartup $state $oldRun $transport $failReceiptSave } 'receipt persistence failure stops startup'
Check ($script:disk.pending.action -ceq 'boot' -and $script:disk.pending.bootId -ceq $oldRun) 'unsaved receipt retains boot request'
$newRun=[Guid]::NewGuid().ToString(); $ready=Invoke-CompanionStartup $script:disk $newRun $transport $writeFixture
Check ($ready.bootId -ceq $newRun -and $script:server.events.Count -eq 3) 'lost persisted receipt recovers then creates fresh boot'
[pscustomobject]@{schema='overdrafter.companion-state-test.v1';assertions=$script:assertions;passed=$true;
    network=$false;disk=$false;dpapiQualified=$false;windowsQualified=$false;nativeActions=0} | ConvertTo-Json
