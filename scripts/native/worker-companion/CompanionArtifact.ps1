#requires -Version 5.1
# Default-off artifact client. The caller supplies an admitted attempt and exact
# candidate files; this module never starts CAD or interprets a result as verified.
Set-StrictMode -Version Latest
function Assert-CompanionArtifactScope($State,$Status,$Scope) {
    $keys=@('organizationId','projectId','workerId','installationId','bootId','sessionId',
        'taskId','attemptId','fence','inputSnapshotId','candidateSnapshotId','predecessorAttemptId')
    Assert-CompanionKeys $Scope $keys
    foreach ($key in $keys) {
        if ($key -ceq 'fence') {
            if (($Scope.fence -isnot [int] -and $Scope.fence -isnot [long]) -or
                $Scope.fence -lt 1 -or $Scope.fence -ge 9007199254740991L) { throw 'Invalid artifact fence.' }
        } elseif ($key -ceq 'predecessorAttemptId') {
            if ($null -ne $Scope.predecessorAttemptId) { Assert-CompanionId $Scope.predecessorAttemptId }
        } else { Assert-CompanionId $Scope.$key }
    }
    # Pause/expiry may drain an already owned attempt. Server authority still
    # rechecks that exact attempt before and after every transfer.
    if ($Scope.workerId -cne $State.workerId -or $Scope.installationId -cne $State.installationId -or
        $Scope.bootId -cne $State.bootId -or $Scope.sessionId -cne $Status.sessionId -or
        $Status.reason -cnotin @('enabled','paused','expired')) { throw 'Artifact scope is not the current companion session.' }
}
function Get-CompanionArtifactUrl([string]$GatewayUrl) {
    Assert-CompanionEndpoint $GatewayUrl
    return $GatewayUrl.Substring(0,$GatewayUrl.Length-'engineering-worker'.Length)+'engineering-worker-artifact'
}
function Get-CompanionSha256([byte[]]$Bytes) {
    $hasher=[Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($hasher.ComputeHash($Bytes)).Replace('-','').ToLowerInvariant() }
    finally { $hasher.Dispose() }
}
function Assert-CompanionArtifactBytes([byte[]]$Bytes,[long]$ExpectedBytes,[string]$ExpectedSha,[long]$Limit) {
    if ($null -eq $Bytes -or $ExpectedBytes -lt 1 -or $ExpectedBytes -gt $Limit -or
        $Bytes.LongLength -ne $ExpectedBytes -or $ExpectedSha -cnotmatch '^[0-9a-f]{64}$' -or
        (Get-CompanionSha256 $Bytes) -cne $ExpectedSha) { throw 'Artifact bytes differ from the admitted manifest.' }
}
function Get-CompanionRoleLimit([string]$Role) {
    switch -CaseSensitive ($Role) {
        'assembly' { return 16000000 }
        'target' { return 16000000 }
        'companion' { return 16000000 }
        'result' { return 256000 }
        'identity' { return 64000 }
        'preservation' { return 128000 }
        'native' { return 4000000 }
        default { throw 'Unsupported artifact role.' }
    }
}
function Save-CompanionPrivateArtifactBytes($Store,[string]$Path,[byte[]]$Bytes) {
    $temporary=Join-Path $Store.root ([Guid]::NewGuid().ToString()+'.artifact.pending')
    $file=New-CompanionPrivateFile $temporary $Store.sid
    try { $file.Write($Bytes,0,$Bytes.Length); $file.Flush($true) } finally { $file.Dispose() }
    Assert-CompanionPrivateAcl $temporary $Store.sid $false
    # CreateNew plus same-directory move makes final names complete and
    # immutable. A failed move leaves the private temporary evidence intact.
    [IO.File]::Move($temporary,$Path)
}
function Read-CompanionArtifactHttpBody($Stream,[int]$Limit,[Threading.CancellationToken]$CancellationToken) {
    $buffer=New-Object byte[] 4096; $memory=New-Object IO.MemoryStream
    try {
        while ($true) {
            $read=$Stream.ReadAsync($buffer,0,$buffer.Length,$CancellationToken)
            $read.Wait($CancellationToken); $count=$read.GetAwaiter().GetResult()
            if ($count -eq 0) { break }
            if ($memory.Length+$count -gt $Limit) { throw 'Artifact HTTP response exceeds bound.' }
            $memory.Write($buffer,0,$count)
        }
        return ,$memory.ToArray()
    } finally { $memory.Dispose() }
}
# The store handle already owns a protected per-worker directory and exclusive
# lock. A retry reads the retained copy, not the mutable candidate source.
function Save-CompanionArtifactSnapshot($Store,[string]$AttemptId,[string]$Role,
    [string]$CandidateRoot,[string]$SourcePath,[long]$ExpectedBytes,[string]$ExpectedSha) {
    Assert-CompanionStoreHandle $Store; Assert-CompanionId $AttemptId
    $limit=Get-CompanionRoleLimit $Role
    $root=Assert-CompanionLocalPath $CandidateRoot
    $source=Assert-CompanionLocalPath $SourcePath
    if (-not $source.StartsWith($root.TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase)) {
        throw 'Artifact source leaves the candidate root.'
    }
    $spool=Join-Path $Store.root ('artifact-'+$AttemptId+'-'+$Role+'.bin')
    $null=Assert-CompanionLocalPath $spool
    if (-not [IO.File]::Exists($spool)) {
        $sourceInfo=New-Object IO.FileInfo($source)
        if (-not $sourceInfo.Exists -or $sourceInfo.Length -ne $ExpectedBytes -or $sourceInfo.Length -gt $limit) {
            throw 'Artifact source size differs from the admitted manifest.'
        }
        $bytes=[IO.File]::ReadAllBytes($source)
        Assert-CompanionArtifactBytes $bytes $ExpectedBytes $ExpectedSha $limit
        Save-CompanionPrivateArtifactBytes $Store $spool $bytes
    }
    Assert-CompanionPrivateAcl $spool $Store.sid $false
    $spoolInfo=New-Object IO.FileInfo($spool)
    if ($spoolInfo.Length -ne $ExpectedBytes -or $spoolInfo.Length -gt $limit) { throw 'Retained artifact size differs.' }
    $retained=[IO.File]::ReadAllBytes($spool)
    Assert-CompanionArtifactBytes $retained $ExpectedBytes $ExpectedSha $limit
    return ,$retained
}
function Save-CompanionInputSnapshot($Store,[string]$AttemptId,[string]$ArtifactId,
    [byte[]]$Bytes,[long]$ExpectedBytes,[string]$ExpectedSha) {
    Assert-CompanionStoreHandle $Store; Assert-CompanionId $AttemptId; Assert-CompanionId $ArtifactId
    Assert-CompanionArtifactBytes $Bytes $ExpectedBytes $ExpectedSha 16000000
    $path=Join-Path $Store.root ('input-'+$AttemptId+'-'+$ArtifactId+'.bin')
    $null=Assert-CompanionLocalPath $path
    if (-not [IO.File]::Exists($path)) {
        Save-CompanionPrivateArtifactBytes $Store $path $Bytes
    }
    Assert-CompanionPrivateAcl $path $Store.sid $false
    $inputInfo=New-Object IO.FileInfo($path)
    if ($inputInfo.Length -ne $ExpectedBytes -or $inputInfo.Length -gt 16000000) { throw 'Retained input size differs.' }
    Assert-CompanionArtifactBytes ([IO.File]::ReadAllBytes($path)) $ExpectedBytes $ExpectedSha 16000000
    return $path
}
function Invoke-CompanionArtifactTransfer($State,$Status,$Scope,[string]$Direction,[string]$ArtifactId,
    [string]$Role,[byte[]]$Bytes,[long]$ExpectedBytes,[string]$ExpectedSha,[scriptblock]$Transport) {
    Assert-CompanionArtifactScope $State $Status $Scope
    if ($Direction -cne 'input' -and $Direction -cne 'output') { throw 'Unsupported artifact direction.' }
    if ($Direction -ceq 'input') { Assert-CompanionId $ArtifactId; if ($Role) { throw 'Input role is not caller-selected.' } }
    else { if ($ArtifactId) { throw 'Output path is not caller-selected.' }; $null=Get-CompanionRoleLimit $Role }
    if ($ExpectedBytes -lt 1 -or $ExpectedBytes -gt $(if ($Direction -ceq 'input') {16000000} else {Get-CompanionRoleLimit $Role}) -or
        $ExpectedSha -cnotmatch '^[0-9a-f]{64}$') { throw 'Invalid artifact manifest.' }
    if ($Direction -ceq 'output') { Assert-CompanionArtifactBytes $Bytes $ExpectedBytes $ExpectedSha (Get-CompanionRoleLimit $Role) }
    $headers=@{'x-overdrafter-scope'=($Scope | ConvertTo-Json -Depth 5 -Compress);
        'x-overdrafter-bytes'=[string]$ExpectedBytes;'x-overdrafter-sha256'=$ExpectedSha}
    if ($Direction -ceq 'input') { $headers['x-overdrafter-artifact-id']=$ArtifactId }
    else { $headers['x-overdrafter-role']=$Role }
    $reply=& $Transport $Direction $headers $Bytes $State.token (Get-CompanionArtifactUrl $State.gatewayUrl)
    if ($null -eq $reply -or $reply.status -ne 200 -or $reply.redirected -eq $true) {
        throw 'Artifact transfer was not confirmed; retain immutable bytes for exact retry.'
    }
    if ($Direction -ceq 'input') {
        Assert-CompanionArtifactBytes $reply.bytes $ExpectedBytes $ExpectedSha 16000000
        return ,$reply.bytes
    }
    if ($reply.body.schema -cne 'overdrafter.native-artifact-transfer.v1' -or
        $reply.body.delivered -ne $true -or $reply.body.role -cne $Role) {
        throw 'Artifact delivery receipt is invalid; retain immutable bytes for exact retry.'
    }
    return $true
}
function Receive-CompanionStoredInput($Store,$State,$Status,$Scope,[string]$ArtifactId,
    [long]$ExpectedBytes,[string]$ExpectedSha) {
    $bytes=Invoke-CompanionArtifactTransfer $State $Status $Scope 'input' $ArtifactId '' $null $ExpectedBytes $ExpectedSha ${function:Send-CompanionArtifactHttp}
    return Save-CompanionInputSnapshot $Store $Scope.attemptId $ArtifactId $bytes $ExpectedBytes $ExpectedSha
}
function Send-CompanionStoredOutput($Store,$State,$Status,$Scope,[string]$Role,
    [string]$CandidateRoot,[string]$SourcePath,[long]$ExpectedBytes,[string]$ExpectedSha) {
    $bytes=Save-CompanionArtifactSnapshot $Store $Scope.attemptId $Role $CandidateRoot $SourcePath $ExpectedBytes $ExpectedSha
    return Invoke-CompanionArtifactTransfer $State $Status $Scope 'output' '' $Role $bytes $ExpectedBytes $ExpectedSha ${function:Send-CompanionArtifactHttp}
}
function Send-CompanionArtifactHttp([string]$Direction,$Headers,[byte[]]$Bytes,[string]$Token,[string]$Url) {
    Assert-CompanionWindows
    if ($Token -cnotmatch '^odw_[0-9a-f]{64}$') { throw 'Invalid companion token.' }
    Add-Type -AssemblyName System.Net.Http
    $handler=New-Object Net.Http.HttpClientHandler
    $handler.AllowAutoRedirect=$false; $handler.UseCookies=$false; $handler.UseProxy=$false
    $handler.AutomaticDecompression=[Net.DecompressionMethods]::None
    $client=New-Object Net.Http.HttpClient($handler,$true)
    $cancel=New-Object Threading.CancellationTokenSource
    $message=$null; $response=$null; $stream=$null
    try {
        $cancel.CancelAfter(30000)
        $method=[Net.Http.HttpMethod]::Get
        if ($Direction -ceq 'output') { $method=[Net.Http.HttpMethod]::Put }
        $message=New-Object Net.Http.HttpRequestMessage($method,$Url)
        $message.Headers.Authorization=New-Object Net.Http.Headers.AuthenticationHeaderValue('Bearer',$Token)
        foreach ($key in $Headers.Keys) { $message.Headers.TryAddWithoutValidation($key,[string]$Headers[$key]) | Out-Null }
        if ($Direction -ceq 'output') {
            $message.Content=[Net.Http.ByteArrayContent]::new($Bytes)
            $message.Content.Headers.ContentType=New-Object Net.Http.Headers.MediaTypeHeaderValue('application/octet-stream')
        }
        $send=$client.SendAsync($message,[Net.Http.HttpCompletionOption]::ResponseHeadersRead,$cancel.Token)
        $send.Wait($cancel.Token); $response=$send.GetAwaiter().GetResult()
        if ([int]$response.StatusCode -ne 200 -or $response.Headers.Location -or
            $response.Content.Headers.ContentEncoding.Count -ne 0) { throw 'Artifact HTTP transport refused or redirected.' }
        $limit=32768
        if ($Direction -ceq 'input') { $limit=[int]$Headers['x-overdrafter-bytes'] }
        if ($response.Content.Headers.ContentLength -gt $limit) { throw 'Artifact HTTP response exceeds bound.' }
        $open=$response.Content.ReadAsStreamAsync(); $open.Wait($cancel.Token); $stream=$open.GetAwaiter().GetResult()
        $body=Read-CompanionArtifactHttpBody $stream $limit $cancel.Token
        if ($Direction -ceq 'input') {
            if ($null -eq $response.Content.Headers.ContentType -or
                $response.Content.Headers.ContentType.MediaType -cne 'application/octet-stream' -or
                -not $response.Headers.Contains('x-overdrafter-sha256') -or
                $response.Headers.GetValues('x-overdrafter-sha256')[0] -cne $Headers['x-overdrafter-sha256']) {
                throw 'Artifact HTTP input headers differ from the admitted manifest.'
            }
            return [pscustomobject]@{status=200;redirected=$false;bytes=$body}
        }
        if ($null -eq $response.Content.Headers.ContentType -or
            $response.Content.Headers.ContentType.MediaType -cne 'application/json') {
            throw 'Artifact HTTP delivery response has unsupported media type.'
        }
        $text=(New-Object Text.UTF8Encoding($false,$true)).GetString($body)
        return [pscustomobject]@{status=200;redirected=$false;body=(ConvertFrom-CompanionJson $text)}
    } finally {
        if ($null -ne $stream) { $stream.Dispose() }
        if ($null -ne $response) { $response.Dispose() }
        if ($null -ne $message) { $message.Dispose() }
        $cancel.Dispose(); $client.Dispose()
    }
}
