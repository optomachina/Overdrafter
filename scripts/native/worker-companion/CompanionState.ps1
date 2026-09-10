#requires -Version 5.1
# Pure session state machine. Persistence and transport are supplied by the
# launcher; this file never reads credentials, writes files or starts native CAD.
Set-StrictMode -Version Latest

function Assert-CompanionKeys($Value, [string[]]$Keys) {
    if ($null -eq $Value -or $Value -isnot [pscustomobject]) { throw 'Invalid companion record.' }
    $actual = @($Value.PSObject.Properties.Name)
    if ($actual.Count -ne $Keys.Count) { throw 'Invalid companion fields.' }
    foreach ($key in $actual) { if ($Keys -cnotcontains $key) { throw 'Invalid companion fields.' } }
}
function Assert-CompanionId($Value) {
    if ($Value -isnot [string] -or $Value -cnotmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' -or
        $Value -ceq '00000000-0000-0000-0000-000000000000') { throw 'Invalid companion identity.' }
}
function Assert-CompanionRevision($Value) {
    if (($Value -isnot [int] -and $Value -isnot [long]) -or $Value -lt 0 -or $Value -gt 9007199254740991L) {
        throw 'Invalid companion revision.'
    }
}
function Assert-CompanionEndpoint($Value) {
    $uri = $null
    if ($Value -isnot [string] -or -not [Uri]::TryCreate($Value, [UriKind]::Absolute, [ref]$uri) -or
        $uri.Scheme -cne 'https' -or $uri.Port -ne 443 -or $uri.UserInfo -or $uri.Query -or $uri.Fragment -or
        $uri.AbsolutePath -cne '/functions/v1/engineering-worker') { throw 'Invalid companion gateway endpoint.' }
}
# Windows PowerShell 5.1 preserves timestamp strings. Core requires DateKind
# (7.5+) to avoid changing the wire representation during receipt replay.
function ConvertFrom-CompanionJson([string]$Json) {
    if ((Get-Command ConvertFrom-Json).Parameters.ContainsKey('DateKind')) { return ConvertFrom-Json -InputObject $Json -DateKind String }
    if ($PSVersionTable.PSEdition -cne 'Desktop') { throw 'Companion JSON requires Windows PowerShell 5.1 or PowerShell Core 7.5+.' }
    return ConvertFrom-Json -InputObject $Json
}
function Copy-CompanionRecord($Value) { return ConvertFrom-CompanionJson ($Value | ConvertTo-Json -Depth 20 -Compress) }
function Assert-CompanionTimestamp($Value) {
    $parsed=[DateTimeOffset]::MinValue
    if ($Value -isnot [string] -or $Value -cnotmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$' -or
        -not [DateTimeOffset]::TryParse($Value,[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::None,[ref]$parsed)) {
        throw 'Invalid companion timestamp.'
    }
}
function New-CompanionSecret([ValidateSet('worker','pairing')][string]$Purpose) {
    $bytes = New-Object byte[] 32
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    $prefix = 'odw_'; if ($Purpose -ceq 'pairing') { $prefix = 'odp_' }
    return $prefix + ([BitConverter]::ToString($bytes).Replace('-', '').ToLowerInvariant())
}
function Assert-CompanionState($State) {
    Assert-CompanionKeys $State @('schema','workerId','installationId','gatewayUrl','token','paired','revision','bootId','pending')
    if ($State.schema -isnot [string] -or $State.schema -cne 'overdrafter.worker-companion.v1' -or $State.paired -isnot [bool] -or
        $State.token -isnot [string] -or $State.token -cnotmatch '^odw_[0-9a-f]{64}$') { throw 'Invalid companion state.' }
    Assert-CompanionId $State.workerId; Assert-CompanionId $State.installationId
    Assert-CompanionEndpoint $State.gatewayUrl; Assert-CompanionRevision $State.revision
    if ($null -ne $State.bootId) { Assert-CompanionId $State.bootId }
    if ($null -eq $State.pending) {
        if (-not $State.paired) { throw 'Unpaired companion has no recoverable request.' }
        return
    }
    $request = $State.pending
    $keys = @('schema','action','workerId','expectedRevision','idempotencyKey')
    if ($State.paired) { $keys += 'bootId' } else { $keys += @('installationId','pairingCode') }
    Assert-CompanionKeys $request $keys
    Assert-CompanionId $request.idempotencyKey; Assert-CompanionId $request.workerId; Assert-CompanionRevision $request.expectedRevision
    if ($request.schema -isnot [string] -or $request.action -isnot [string] -or $request.schema -cne 'overdrafter.worker-gateway.v1' -or $request.workerId -cne $State.workerId -or
        $request.expectedRevision -ne $State.revision -or $request.expectedRevision -ge 9007199254740991L) { throw 'Invalid pending companion request.' }
    if ($State.paired) {
        if ($request.action -cne 'boot') { throw 'Invalid pending companion action.' }
        Assert-CompanionId $request.bootId
    } else {
        Assert-CompanionId $request.installationId
        if ($request.action -cne 'pair' -or $request.installationId -cne $State.installationId -or $State.revision -ne 1 -or
            $null -ne $State.bootId -or $request.pairingCode -isnot [string] -or $request.pairingCode -cnotmatch '^odp_[0-9a-f]{64}$') {
            throw 'Invalid pending companion pairing.'
        }
    }
}
# The launcher must save this record under DPAPI before invoking startup.
function New-CompanionState([string]$WorkerId, [string]$GatewayUrl, [string]$PairingCode) {
    $installation = [Guid]::NewGuid().ToString()
    $state = [pscustomobject][ordered]@{ schema='overdrafter.worker-companion.v1'; workerId=$WorkerId;
        installationId=$installation; gatewayUrl=$GatewayUrl; token=(New-CompanionSecret worker); paired=$false;
        revision=1; bootId=$null; pending=[pscustomobject][ordered]@{schema='overdrafter.worker-gateway.v1'; action='pair';
            workerId=$WorkerId; expectedRevision=1; idempotencyKey=[Guid]::NewGuid().ToString(); installationId=$installation; pairingCode=$PairingCode} }
    Assert-CompanionState $state
    return $state
}
# Never retain or reflect a raw transport exception or backend error. Unknown
# mutations leave the durable request untouched for exact replay.
function Invoke-CompanionExchange($State, $Request, [scriptblock]$Transport) {
    try { $response = & $Transport (Copy-CompanionRecord $Request) $State.token $State.gatewayUrl }
    catch { throw 'Companion connection unresolved; retain the encrypted pending request.' }
    Assert-CompanionKeys $response @('status','body')
    if ($response.status -isnot [int] -and $response.status -isnot [long]) { throw 'Invalid companion HTTP result.' }
    if ($response.status -eq 409) {
        Assert-CompanionKeys $response.body @('schema','error','outcome','retrySameRequest')
        if ($response.body.schema -is [string] -and $response.body.error -is [string] -and $response.body.outcome -is [string] -and
            $response.body.schema -ceq 'overdrafter.worker-gateway.v1' -and $response.body.error -ceq 'worker_conflict' -and
            $response.body.outcome -ceq 'not_applied' -and $response.body.retrySameRequest -is [bool] -and -not $response.body.retrySameRequest) {
            return [pscustomobject]@{conflict=$true; receipt=$null}
        }
    }
    if ($response.status -ne 200) { throw 'Companion request refused or unresolved; retain encrypted state.' }
    Assert-CompanionKeys $response.body @('schema','action','receipt')
    if ($response.body.schema -isnot [string] -or $response.body.action -isnot [string] -or
        $response.body.schema -cne 'overdrafter.worker-gateway.v1' -or $response.body.action -cne $Request.action) { throw 'Invalid companion response binding.' }
    $receipt = $response.body.receipt
    if ($Request.action -ceq 'pair') { $keys = @('workerId','revision','installationId','pairedAt') }
    elseif ($Request.action -ceq 'boot') { $keys = @('workerId','revision','bootId','enabled') }
    else { $keys = @('workerId','revision','installationId','bootId','sessionId','sessionEligible','reason','expiresAt') }
    Assert-CompanionKeys $receipt $keys; Assert-CompanionRevision $receipt.revision; Assert-CompanionId $receipt.workerId
    if ($receipt.workerId -cne $State.workerId) { throw 'Invalid companion response worker.' }
    if ($Request.action -ceq 'pair') {
        Assert-CompanionTimestamp $receipt.pairedAt; Assert-CompanionId $receipt.installationId
        if ($receipt.revision -ne ($Request.expectedRevision+1) -or $receipt.installationId -cne $State.installationId) { throw 'Invalid companion pairing receipt.' }
    } elseif ($Request.action -ceq 'boot') {
        Assert-CompanionId $receipt.bootId
        if ($receipt.revision -ne ($Request.expectedRevision+1) -or $receipt.bootId -cne $Request.bootId -or
            $receipt.enabled -isnot [bool] -or $receipt.enabled) { throw 'Invalid companion boot receipt.' }
    } else {
        Assert-CompanionSession $State $Request $receipt
    }
    return [pscustomobject]@{conflict=$false; receipt=$receipt}
}
function Assert-CompanionSession($State, $Request, $Receipt) {
    $reasons = @('enabled','paused','expired','boot_mismatch','owner_enablement_required')
    Assert-CompanionId $Receipt.installationId
    if ($Receipt.reason -isnot [string] -or $Receipt.installationId -cne $State.installationId -or $reasons -cnotcontains $Receipt.reason -or
        $Receipt.sessionEligible -isnot [bool] -or $Receipt.sessionEligible -ne ($Receipt.reason -ceq 'enabled')) { throw 'Invalid companion session receipt.' }
    if ($null -ne $Receipt.bootId) { Assert-CompanionId $Receipt.bootId }
    if ($null -ne $Receipt.sessionId) { Assert-CompanionId $Receipt.sessionId }
    if ($null -ne $Receipt.expiresAt) { Assert-CompanionTimestamp $Receipt.expiresAt }
    if ($Receipt.reason -ceq 'boot_mismatch') {
        if ($Receipt.bootId -ceq $Request.bootId) { throw 'Invalid companion boot mismatch.' }
    } elseif ($Receipt.bootId -cne $Request.bootId) { throw 'Invalid companion session boot.' }
    if ($Receipt.reason -ceq 'owner_enablement_required') {
        if ($null -ne $Receipt.sessionId -or $null -ne $Receipt.expiresAt) { throw 'Invalid unenabled companion session.' }
    } elseif ($Receipt.reason -cne 'boot_mismatch') {
        if ($null -eq $Receipt.sessionId -or $null -eq $Receipt.expiresAt) { throw 'Invalid companion grant.' }
    }
}
function Get-CompanionSession($State, [string]$BootId, [scriptblock]$Transport) {
    Assert-CompanionState $State; Assert-CompanionId $BootId
    $request = [pscustomobject]@{schema='overdrafter.worker-gateway.v1'; action='session'; workerId=$State.workerId; bootId=$BootId}
    $response = Invoke-CompanionExchange $State $request $Transport
    if ($response.conflict) { throw 'Companion status cannot resolve a revision conflict.' }
    return $response.receipt
}
# RunId is freshly generated by the launcher on every process start. Replaying
# an old boot is recovery only; it must be followed by the new process's boot.
function Invoke-CompanionStartup($State, [string]$RunId, [scriptblock]$Transport, [scriptblock]$Persist) {
    Assert-CompanionState $State; Assert-CompanionId $RunId
    $working = Copy-CompanionRecord $State
    $conflicts = 0
    for ($step=0; $step -lt 6; $step++) {
        if ($null -ne $working.pending) {
            $request = $working.pending
            $response = Invoke-CompanionExchange $working $request $Transport
            if ($response.conflict) {
                if ($request.action -cne 'boot' -or $conflicts -ge 1) { throw 'Companion revision conflict requires reconciliation.' }
                $conflicts++; $working.pending=$null
                # The server explicitly refused this operation, so a fresh
                # revision/key is permitted. Unknown outcomes never reach here.
                & $Persist (Copy-CompanionRecord $working) | Out-Null
                continue
            }
            $working.revision = $response.receipt.revision
            if ($request.action -ceq 'pair') { $working.paired=$true } else { $working.bootId=$request.bootId }
            $working.pending=$null
            & $Persist (Copy-CompanionRecord $working) | Out-Null
        }
        if ($working.paired -and $working.bootId -ceq $RunId) { return $working }
        $status = Get-CompanionSession $working $RunId $Transport
        if ($status.revision -ge 9007199254740991L) { throw 'Companion revision limit reached.' }
        $working.revision=$status.revision
        $working.pending=[pscustomobject][ordered]@{schema='overdrafter.worker-gateway.v1'; action='boot'; workerId=$working.workerId;
            expectedRevision=$working.revision; idempotencyKey=[Guid]::NewGuid().ToString(); bootId=$RunId}
        Assert-CompanionState $working
        & $Persist (Copy-CompanionRecord $working) | Out-Null
    }
    throw 'Companion startup did not converge; retain encrypted state.'
}
