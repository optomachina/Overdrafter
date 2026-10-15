#requires -Version 5.1
# Exact output recovery only. No claim, boot, heartbeat, process or stop mutation.
Set-StrictMode -Version Latest
function Get-CompanionOutputScope($Task) {
    Assert-CompanionTask $Task
    if ($Task.phase -cnotin @('running','recovery_required','awaiting_stop_admission')) { throw 'Output recovery requires a prior launched attempt.' }
    $claim=$Task.receipt
    if ((Get-CompanionTextHash $claim.jobText) -cne $claim.jobSha256 -or
        (Get-CompanionTextHash $claim.contextText) -cne $claim.contextSha256) { throw 'Retained claim bytes differ.' }
    $job=ConvertFrom-CompanionJson $claim.jobText
    $context=ConvertFrom-CompanionJson $claim.contextText
    if ($job.schema -cne 'overdrafter.prepared-dimension-job.v2' -or
        $job.attemptId -cne $claim.attemptId -or $job.fence -ne $claim.fence -or
        $job.contextSha256 -cne $claim.contextSha256 -or $job.inputSnapshotId -cne $context.snapshotId -or
        $job.outputSnapshotId -ceq $job.inputSnapshotId -or
        $job.scope.organizationId -cne $context.scope.organizationId -or
        $job.scope.projectId -cne $context.scope.projectId -or
        $claim.workerId -cne $Task.workerId -or $claim.bootId -cne $Task.bootId -or
        $claim.taskId -cne $Task.taskId) { throw 'Retained output attempt binding differs.' }
    $predecessor=$null
    if ($null -ne $context.producer) { $predecessor=$context.producer.attemptId }
    return [pscustomobject][ordered]@{organizationId=$job.scope.organizationId;projectId=$job.scope.projectId;
        workerId=$Task.workerId;installationId=$claim.installationId;bootId=$Task.bootId;
        sessionId=$claim.sessionId;taskId=$Task.taskId;attemptId=$claim.attemptId;fence=$claim.fence;
        inputSnapshotId=$job.inputSnapshotId;candidateSnapshotId=$job.outputSnapshotId;predecessorAttemptId=$predecessor}
}
function Assert-CompanionOutputReplay($Descriptor,$Task,$State,$Status) {
    Assert-CompanionKeys $Descriptor @('schema','gatewayUrl','scope','files')
    if ($Descriptor.schema -cne 'overdrafter.companion-output-replay.v1' -or
        $Descriptor.gatewayUrl -cne $State.gatewayUrl) { throw 'Output replay endpoint differs.' }
    Assert-CompanionArtifactScope $State $Status $Descriptor.scope
    $expected=Get-CompanionOutputScope $Task
    foreach ($property in $expected.PSObject.Properties) {
        if ($Descriptor.scope.($property.Name) -cne $property.Value) { throw 'Output replay differs from retained attempt.' }
    }
    $roles=@('assembly','target','companion','result','identity','preservation','native')
    if (@($Descriptor.files).Count -ne $roles.Count) { throw 'Output replay requires all seven immutable roles.' }
    for ($i=0; $i -lt $roles.Count; $i++) {
        $file=$Descriptor.files[$i]
        Assert-CompanionKeys $file @('role','bytes','sha256')
        if ($file.role -cne $roles[$i] -or ($file.bytes -isnot [int] -and $file.bytes -isnot [long]) -or
            $file.bytes -lt 1 -or $file.bytes -gt (Get-CompanionRoleLimit $file.role) -or
            $file.sha256 -cnotmatch '^[0-9a-f]{64}$') { throw 'Output replay manifest differs.' }
    }
}
function Read-CompanionOutputBytes($Store,[string]$AttemptId,$File) {
    Assert-CompanionStoreHandle $Store; Assert-CompanionId $AttemptId
    $limit=Get-CompanionRoleLimit $File.role
    $path=Join-Path $Store.root ('artifact-'+$AttemptId+'-'+$File.role+'.bin')
    Assert-CompanionPrivateAcl $path $Store.sid $false
    $info=New-Object IO.FileInfo($path)
    if ($info.Length -ne $File.bytes -or $info.Length -gt $limit) { throw 'Retained output spool size differs.' }
    $bytes=[IO.File]::ReadAllBytes($path)
    Assert-CompanionArtifactBytes $bytes $File.bytes $File.sha256 $limit
    return ,$bytes
}
function Read-CompanionOutputReplay($Store,[string]$AttemptId) {
    Assert-CompanionStoreHandle $Store; Assert-CompanionId $AttemptId
    $path=Join-Path $Store.root ('output-replay-'+$AttemptId+'.json')
    Assert-CompanionPrivateAcl $path $Store.sid $false
    $info=New-Object IO.FileInfo($path)
    if ($info.Length -lt 1 -or $info.Length -gt 8192) { throw 'Output replay descriptor size differs.' }
    return ConvertFrom-CompanionJson ([IO.File]::ReadAllText($path))
}
function Save-CompanionOutputReplay($Store,$Task,$State,$Status,[string]$CandidateRoot,[string[]]$Paths) {
    Assert-CompanionStoreHandle $Store
    $scope=Get-CompanionOutputScope $Task
    $roles=@('assembly','target','companion','result','identity','preservation','native')
    if ($Paths.Count -ne $roles.Count) { throw 'Output replay requires seven source paths.' }
    $path=Join-Path $Store.root ('output-replay-'+$scope.attemptId+'.json')
    if ([IO.File]::Exists($path)) { throw 'Existing output descriptor requires replay only.' }
    $root=Assert-CompanionLocalPath $CandidateRoot
    $files=@()
    for ($i=0; $i -lt $roles.Count; $i++) {
        $source=Assert-CompanionLocalPath $Paths[$i]
        if (-not $source.StartsWith($root.TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Output source leaves the candidate root.' }
        $info=New-Object IO.FileInfo($source)
        if (-not $info.Exists -or $info.Length -lt 1 -or $info.Length -gt (Get-CompanionRoleLimit $roles[$i])) { throw 'Output source size differs.' }
        $sha=Get-CompanionSha256 ([IO.File]::ReadAllBytes($source))
        $null=Save-CompanionArtifactSnapshot $Store $scope.attemptId $roles[$i] $CandidateRoot $source $info.Length $sha
        $files+=@([pscustomobject]@{role=$roles[$i];bytes=$info.Length;sha256=$sha})
    }
    $descriptor=[pscustomobject]@{schema='overdrafter.companion-output-replay.v1';gatewayUrl=$State.gatewayUrl;scope=$scope;files=$files}
    Assert-CompanionOutputReplay $descriptor $Task $State $Status
    # Publish only after all seven exact spools exist; no PUT can precede this.
    $bytes=[Text.Encoding]::UTF8.GetBytes(($descriptor | ConvertTo-Json -Depth 8 -Compress))
    if ($bytes.Length -gt 8192) { throw 'Output replay descriptor exceeds bound.' }
    Save-CompanionPrivateArtifactBytes $Store $path $bytes
    return $descriptor
}
function Invoke-CompanionOutputReplay($Descriptor,$Task,$State,$Status,[scriptblock]$ReadBytes,[scriptblock]$Transport) {
    Assert-CompanionOutputReplay $Descriptor $Task $State $Status
    # Validate the complete set before any send. Only bounded retained bytes are
    # admitted; the reader has no candidate path or mutable-source fallback.
    $retained=@{}
    foreach ($file in $Descriptor.files) {
        $bytes=& $ReadBytes $Descriptor.scope.attemptId $file
        Assert-CompanionArtifactBytes $bytes $file.bytes $file.sha256 (Get-CompanionRoleLimit $file.role)
        $retained[$file.role]=$bytes
    }
    foreach ($file in $Descriptor.files) {
        $null=Invoke-CompanionArtifactTransfer $State $Status $Descriptor.scope 'output' '' $file.role $retained[$file.role] $file.bytes $file.sha256 $Transport
    }
    return [pscustomobject]@{schema='overdrafter.companion-output-replay-status.v1';taskId=$Task.taskId;
        attemptId=$Descriptor.scope.attemptId;fence=$Descriptor.scope.fence;phase='outputs_delivered';
        deliveredRoles=7;nativeExecutionAttempted=$false;resultEligible=$false;stopAdmissionPending=$true}
}
