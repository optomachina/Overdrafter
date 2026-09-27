#requires -Version 5.1
# One-task state and protocol. No native process is started by this module.
Set-StrictMode -Version Latest
function Assert-CompanionTask($Task) {
    Assert-CompanionKeys $Task @('schema','workerId','bootId','taskId','runtimeAdmissionId','inputAdmissionId','phase','pending','heartbeat','receipt')
    if ($Task.schema -cne 'overdrafter.companion-task.v1' -or
        $Task.phase -cnotin @('claim_pending','claim_unknown','ineligible','claimed','launch_committed','running','awaiting_stop_admission','recovery_required','stopped') -or
        $Task.workerId -isnot [string]) { throw 'Invalid companion task state.' }
    foreach ($key in @('workerId','bootId','taskId','runtimeAdmissionId','inputAdmissionId')) { Assert-CompanionId $Task.$key }
    if ($null -ne $Task.pending) {
        Assert-CompanionKeys $Task.pending @('schema','action','workerId','bootId','taskId','runtimeAdmissionId','inputAdmissionId','revision','idempotencyKey')
        if ($Task.pending.schema -cne 'overdrafter.worker-task.v1' -or $Task.pending.action -cne 'claim' -or
            $Task.pending.workerId -cne $Task.workerId -or $Task.pending.bootId -cne $Task.bootId -or
            $Task.pending.taskId -cne $Task.taskId -or $Task.pending.runtimeAdmissionId -cne $Task.runtimeAdmissionId -or
            $Task.pending.inputAdmissionId -cne $Task.inputAdmissionId) { throw 'Pending claim differs from task.' }
        Assert-CompanionRevision $Task.pending.revision; Assert-CompanionId $Task.pending.idempotencyKey
    }
    if ($Task.phase -cin @('claim_pending','claim_unknown') -and $null -eq $Task.pending) { throw 'Missing recoverable claim.' }
    if ($Task.phase -cin @('claimed','launch_committed','running','awaiting_stop_admission','recovery_required','stopped') -and $null -eq $Task.receipt) {
        throw 'Claimed task lacks an immutable receipt.'
    }
    if ($null -ne $Task.heartbeat) {
        Assert-CompanionKeys $Task.heartbeat @('schema','action','workerId','bootId','taskId','attemptId','fence','revision','idempotencyKey')
        if ($Task.heartbeat.schema -cne 'overdrafter.worker-task.v1' -or $Task.heartbeat.action -cne 'heartbeat' -or
            $Task.heartbeat.workerId -cne $Task.workerId -or $Task.heartbeat.bootId -cne $Task.bootId -or
            $Task.heartbeat.taskId -cne $Task.taskId -or $null -eq $Task.receipt -or
            $Task.heartbeat.attemptId -cne $Task.receipt.attemptId -or $Task.heartbeat.fence -ne $Task.receipt.fence) {
            throw 'Pending heartbeat differs from exact task.'
        }
        Assert-CompanionRevision $Task.heartbeat.revision; Assert-CompanionId $Task.heartbeat.idempotencyKey
    }
}
function New-CompanionTask($State,[string]$TaskId,[string]$RuntimeAdmissionId,[string]$InputAdmissionId,[long]$Revision) {
    Assert-CompanionState $State
    if (-not $State.paired -or $null -eq $State.bootId) { throw 'Paired current boot is required.' }
    foreach ($value in @($TaskId,$RuntimeAdmissionId,$InputAdmissionId)) { Assert-CompanionId $value }
    Assert-CompanionRevision $Revision
    $pending=[pscustomobject]@{schema='overdrafter.worker-task.v1';action='claim';workerId=$State.workerId;
        bootId=$State.bootId;taskId=$TaskId;runtimeAdmissionId=$RuntimeAdmissionId;
        inputAdmissionId=$InputAdmissionId;revision=$Revision;idempotencyKey=[Guid]::NewGuid().ToString()}
    $task=[pscustomobject]@{schema='overdrafter.companion-task.v1';workerId=$State.workerId;
        bootId=$State.bootId;taskId=$TaskId;runtimeAdmissionId=$RuntimeAdmissionId;
        inputAdmissionId=$InputAdmissionId;phase='claim_pending';pending=$pending;heartbeat=$null;receipt=$null}
    Assert-CompanionTask $task; return $task
}
function Get-CompanionTaskUrl([string]$GatewayUrl) {
    Assert-CompanionEndpoint $GatewayUrl
    return $GatewayUrl.Substring(0,$GatewayUrl.Length-'engineering-worker'.Length)+'engineering-worker-task'
}
function Get-CompanionTextHash([string]$Text) {
    $sha=[Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Text))).Replace('-','').ToLowerInvariant() }
    finally { $sha.Dispose() }
}
function Assert-CompanionClaimReceipt($Task,$Receipt) {
    Assert-CompanionKeys $Receipt @('outcome','taskId','taskRevision','attemptId','attemptRevision','workerId','installationId',
        'bootId','sessionId','runtimeAdmissionId','inputAdmissionId','fence','jobText','jobSha256','contextText',
        'contextSha256','claimedAt','deadlineAt','leaseExpiresAt')
    foreach ($key in @('attemptId','installationId','sessionId')) { Assert-CompanionId $Receipt.$key }
    foreach ($key in @('taskRevision','attemptRevision','fence')) { Assert-CompanionRevision $Receipt.$key }
    foreach ($key in @('claimedAt','deadlineAt','leaseExpiresAt')) { Assert-CompanionTimestamp $Receipt.$key }
    if ($Receipt.outcome -cne 'claimed' -or $Receipt.taskId -cne $Task.taskId -or
        $Receipt.workerId -cne $Task.workerId -or $Receipt.bootId -cne $Task.bootId -or
        $Receipt.runtimeAdmissionId -cne $Task.runtimeAdmissionId -or
        $Receipt.inputAdmissionId -cne $Task.inputAdmissionId -or
        $Receipt.taskRevision -ne ($Task.pending.revision+1) -or $Receipt.fence -lt 1 -or
        $Receipt.jobSha256 -cnotmatch '^[0-9a-f]{64}$' -or $Receipt.contextSha256 -cnotmatch '^[0-9a-f]{64}$' -or
        $Receipt.jobText -isnot [string] -or $Receipt.contextText -isnot [string] -or
        (Get-CompanionTextHash $Receipt.jobText) -cne $Receipt.jobSha256 -or
        (Get-CompanionTextHash $Receipt.contextText) -cne $Receipt.contextSha256) {
        throw 'Claim receipt differs from exact admitted task.'
    }
    $job=ConvertFrom-CompanionJson $Receipt.jobText
    $context=ConvertFrom-CompanionJson $Receipt.contextText
    if ($job.schema -cne 'overdrafter.prepared-dimension-job.v2' -or $job.attemptId -cne $Receipt.attemptId -or
        $job.fence -ne $Receipt.fence -or $job.contextSha256 -cne $Receipt.contextSha256 -or
        $job.inputSnapshotId -cne $context.snapshotId -or $job.outputSnapshotId -ceq $job.inputSnapshotId) {
        throw 'Claim job/context binding differs.'
    }
    if ([DateTimeOffset]::Parse($Receipt.deadlineAt)-[DateTimeOffset]::Parse($Receipt.claimedAt) -ne [TimeSpan]::FromMinutes(10) -or
        [DateTimeOffset]::Parse($Receipt.leaseExpiresAt) -gt [DateTimeOffset]::Parse($Receipt.deadlineAt)) {
        throw 'Claim fixed deadline differs.'
    }
}
function Invoke-CompanionTaskClaim($Task,$State,$Status,[scriptblock]$Transport,[scriptblock]$Persist) {
    Assert-CompanionTask $Task
    if ($Task.phase -cne 'claim_pending' -and $Task.phase -cne 'claim_unknown') { throw 'Task claim cannot be repeated as new work.' }
    if ($Task.phase -ceq 'claim_pending' -and ($Status.reason -cne 'enabled' -or -not $Status.sessionEligible)) {
        throw 'Current paired session is not eligible to claim.'
    }
    $wasUnknown=$Task.phase -ceq 'claim_unknown'
    try { $response=& $Transport (Copy-CompanionRecord $Task.pending) $State.token (Get-CompanionTaskUrl $State.gatewayUrl) }
    catch {
        $Task.phase='claim_unknown'; & $Persist $Task
        throw 'Task claim outcome is unknown; exact replay is reconciliation only.'
    }
    if ($response.status -ne 200 -or $response.body.schema -cne 'overdrafter.worker-task.v1' -or
        $response.body.action -cne 'claim') {
        $Task.phase='claim_unknown'; & $Persist $Task
        throw 'Task claim response unresolved; retain exact request.'
    }
    if ($response.body.receipt.outcome -ceq 'ineligible') {
        $Task.phase='ineligible'; $Task.pending=$null; & $Persist $Task
        return $Task
    }
    Assert-CompanionClaimReceipt $Task $response.body.receipt
    if ($response.body.receipt.installationId -cne $State.installationId) { throw 'Claim installation differs from paired companion.' }
    $Task.receipt=$response.body.receipt; $Task.pending=$null
    $Task.phase='claimed'; if ($wasUnknown) { $Task.phase='recovery_required' }
    & $Persist $Task; return $Task
}
function Assert-CompanionFreshEligibility($Task,$State,[scriptblock]$Transport) {
    Assert-CompanionTask $Task
    if ($Task.phase -cnotin @('claimed','running')) { throw 'Current admitted attempt is required.' }
    $receipt=$Task.receipt
    $request=[pscustomobject]@{schema='overdrafter.worker-task.v1';action='eligibility';workerId=$Task.workerId;
        bootId=$Task.bootId;taskId=$Task.taskId;attemptId=$receipt.attemptId;fence=$receipt.fence}
    $response=& $Transport $request $State.token (Get-CompanionTaskUrl $State.gatewayUrl)
    if ($response.status -ne 200 -or $response.body.schema -cne 'overdrafter.worker-task.v1' -or
        $response.body.action -cne 'eligibility') { throw 'Fresh attempt authority is unavailable.' }
    $fresh=$response.body.receipt
    Assert-CompanionKeys $fresh @('attemptId','fence','eligible','reason','revision','leaseExpiresAt','deadlineAt')
    if ($fresh.attemptId -cne $receipt.attemptId -or $fresh.fence -ne $receipt.fence -or
        $fresh.eligible -ne $true -or $fresh.reason -cne 'eligible' -or
        $fresh.revision -ne $receipt.attemptRevision -or
        $fresh.deadlineAt -cne $receipt.deadlineAt -or
        [DateTimeOffset]::UtcNow -ge [DateTimeOffset]::Parse($fresh.leaseExpiresAt) -or
        [DateTimeOffset]::UtcNow -ge [DateTimeOffset]::Parse($fresh.deadlineAt)) {
        throw 'Fresh attempt authority differs or expired.'
    }
    return $fresh
}
function Invoke-CompanionTaskHeartbeat($Task,$State,[scriptblock]$Transport,[scriptblock]$Persist) {
    Assert-CompanionTask $Task
    if ($Task.phase -cnotin @('claimed','running','recovery_required') -or
        ($Task.phase -ceq 'recovery_required' -and $null -eq $Task.heartbeat)) {
        throw 'Heartbeat requires the same retained admitted attempt.'
    }
    if ($null -eq $Task.heartbeat) {
        $Task.heartbeat=[pscustomobject]@{schema='overdrafter.worker-task.v1';action='heartbeat';
            workerId=$Task.workerId;bootId=$Task.bootId;taskId=$Task.taskId;
            attemptId=$Task.receipt.attemptId;fence=$Task.receipt.fence;
            revision=$Task.receipt.attemptRevision;idempotencyKey=[Guid]::NewGuid().ToString()}
        & $Persist $Task
    }
    $request=Copy-CompanionRecord $Task.heartbeat
    try { $response=& $Transport $request $State.token (Get-CompanionTaskUrl $State.gatewayUrl) }
    catch { throw 'Heartbeat outcome unknown; retain exact request and current occupancy.' }
    if ($response.status -ne 200 -or $response.body.schema -cne 'overdrafter.worker-task.v1' -or
        $response.body.action -cne 'heartbeat') { throw 'Heartbeat unresolved; retain exact request.' }
    $receipt=$response.body.receipt
    if ($receipt.attemptId -cne $Task.receipt.attemptId -or $receipt.fence -ne $Task.receipt.fence -or
        $receipt.revision -ne ($request.revision+1)) { throw 'Heartbeat receipt differs from attempt and revision.' }
    if ($receipt.outcome -ceq 'renewed') {
        Assert-CompanionKeys $receipt @('outcome','attemptId','fence','revision','leaseExpiresAt','deadlineAt')
        Assert-CompanionTimestamp $receipt.leaseExpiresAt; Assert-CompanionTimestamp $receipt.deadlineAt
        if ($receipt.deadlineAt -cne $Task.receipt.deadlineAt -or
            [DateTimeOffset]::Parse($receipt.leaseExpiresAt) -gt [DateTimeOffset]::Parse($receipt.deadlineAt)) {
            throw 'Heartbeat extended beyond fixed deadline.'
        }
        $Task.receipt.attemptRevision=$receipt.revision
        $Task.receipt.leaseExpiresAt=$receipt.leaseExpiresAt
        $Task.heartbeat=$null; & $Persist $Task
        return $receipt
    }
    if ($receipt.outcome -ceq 'recovery_required') {
        Assert-CompanionKeys $receipt @('outcome','reason','attemptId','fence','revision')
        $Task.receipt.attemptRevision=$receipt.revision
        $Task.heartbeat=$null; $Task.phase='recovery_required'; & $Persist $Task
        return $receipt
    }
    throw 'Heartbeat response cannot grant native authority.'
}
function Save-CompanionTask($Store,$Task) {
    Assert-CompanionStoreHandle $Store; Assert-CompanionTask $Task
    if ($Task.workerId -cne $Store.workerId) { throw 'Task worker differs from protected store.' }
    $path=Join-Path $Store.root ('task-'+$Task.taskId+'.dpapi')
    $plain=[Text.Encoding]::UTF8.GetBytes(($Task | ConvertTo-Json -Depth 25 -Compress))
    if ($plain.Length -gt 180000) { throw 'Task state exceeds bound.' }
    $entropy=[Text.Encoding]::UTF8.GetBytes('overdrafter.companion-task.v1:'+$Task.workerId+':'+$Task.taskId)
    try { $cipher=[Security.Cryptography.ProtectedData]::Protect($plain,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser) }
    finally { [Array]::Clear($plain,0,$plain.Length) }
    $temporary=Join-Path $Store.root ([Guid]::NewGuid().ToString()+'.task.pending')
    $stream=New-CompanionPrivateFile $temporary $Store.sid
    try { $stream.Write($cipher,0,$cipher.Length); $stream.Flush($true) } finally { $stream.Dispose() }
    if ([IO.File]::Exists($path)) {
        Assert-CompanionPrivateAcl $path $Store.sid $false
        [IO.File]::Replace($temporary,$path,[NullString]::Value)
    } else { [IO.File]::Move($temporary,$path) }
    Assert-CompanionPrivateAcl $path $Store.sid $false
}
function Read-CompanionTask($Store,[string]$TaskId) {
    Assert-CompanionStoreHandle $Store; Assert-CompanionId $TaskId
    $path=Join-Path $Store.root ('task-'+$TaskId+'.dpapi')
    Assert-CompanionPrivateAcl $path $Store.sid $false
    $file=New-Object IO.FileInfo($path)
    if ($file.Length -lt 1 -or $file.Length -gt 190000) { throw 'Task ciphertext size invalid.' }
    $cipher=[IO.File]::ReadAllBytes($path)
    $entropy=[Text.Encoding]::UTF8.GetBytes('overdrafter.companion-task.v1:'+$Store.workerId+':'+$TaskId)
    $plain=$null
    try {
        $plain=[Security.Cryptography.ProtectedData]::Unprotect($cipher,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
        if ($plain.Length -gt 180000) { throw 'Task plaintext exceeds bound.' }
        $task=ConvertFrom-CompanionJson ((New-Object Text.UTF8Encoding($false,$true)).GetString($plain))
        Assert-CompanionTask $task
        if ($task.workerId -cne $Store.workerId -or $task.taskId -cne $TaskId) { throw 'Task state identity differs.' }
        return $task
    } finally { if ($null -ne $plain) { [Array]::Clear($plain,0,$plain.Length) } }
}
