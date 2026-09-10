# V2 consistency checks only. The future authenticated coordinator supplies the
# eligible context/job. Operator-selected files are not worker attestation.
# Requires WireContract.ps1. Loading this file performs no native action.
function Assert-CumulativeUuid($Value) {
    if ($Value -isnot [string] -or $Value -cnotmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' -or
        $Value -ceq '00000000-0000-0000-0000-000000000000') { throw 'Expected a nonzero canonical UUID.' }
}
function Assert-CumulativeDigest($Value) {
    if ($Value -isnot [string] -or $Value -cnotmatch '^[0-9a-f]{64}$') { throw 'Expected SHA-256 digest.' }
}
function Assert-CumulativeInteger($Value, [long]$Minimum) {
    if (-not (Test-PreparedNumber $Value) -or $Value -lt $Minimum -or $Value -gt 9007199254740991 -or
        [Math]::Floor([double]$Value) -ne $Value) { throw 'Expected a bounded integer.' }
}
function Assert-CumulativeDepth($Value) {
    if (-not (Test-PreparedNumber $Value) -or $Value -lt 6 -or $Value -gt 10) { throw 'Expected a depth from 6 to 10 mm.' }
}
function Assert-CumulativeScope($Scope) {
    Assert-PreparedKeys $Scope @('organizationId', 'projectId')
    Assert-CumulativeUuid $Scope.organizationId; Assert-CumulativeUuid $Scope.projectId
}
function Assert-CumulativeFiles($Files) {
    if ($Files -isnot [array] -or $Files.Count -ne 3) { throw 'Exactly three native identities required.' }
    for ($i = 0; $i -lt 3; $i++) {
        $file = $Files[$i]; $expected = $PreparedFiles[$i]
        Assert-PreparedKeys $file @('path', 'bytes', 'sha256')
        if (-not (Test-PreparedText $file.path $expected.path)) { throw 'Native path/order differs.' }
        Assert-CumulativeInteger $file.bytes 1; Assert-CumulativeDigest $file.sha256
        if ($file.bytes -gt 16000000) { throw 'Native file exceeds prepared envelope.' }
        if ($i -eq 2 -and ($file.bytes -ne $expected.bytes -or $file.sha256 -cne $expected.sha256)) { throw 'Fixed companion identity differs.' }
    }
}
function Assert-CumulativeSameFiles($Actual, $Expected) {
    # Measurements are ordered dictionaries; decoded wire records are PSCustomObject.
    $Actual = @($Actual | ForEach-Object { [pscustomobject]$_ })
    $Expected = @($Expected | ForEach-Object { [pscustomobject]$_ })
    Assert-CumulativeFiles $Actual; Assert-CumulativeFiles $Expected
    for ($i = 0; $i -lt 3; $i++) {
        if ($Actual[$i].sha256 -cne $Expected[$i].sha256 -or $Actual[$i].bytes -ne $Expected[$i].bytes) { throw 'Predecessor file identity differs.' }
    }
}
function Assert-CumulativeChecks($Checks) {
    if ($Checks -isnot [array] -or $Checks.Count -ne 7) { throw 'All seven passing checks required.' }
    for ($i = 0; $i -lt 7; $i++) {
        $check = $Checks[$i]
        Assert-PreparedKeys $check @('id', 'verdict', 'evidenceSha256')
        if (-not (Test-PreparedText $check.id $PreparedChecks[$i]) -or -not (Test-PreparedText $check.verdict 'pass')) { throw 'Mandatory check identity or verdict differs.' }
        Assert-CumulativeDigest $check.evidenceSha256
    }
}
function Assert-CumulativeContext($Context) {
    Assert-PreparedKeys $Context @('schema', 'packageId', 'scope', 'snapshotId', 'seedSnapshotId', 'sequence',
        'producer', 'createdAt', 'configuration', 'assemblyPath', 'files', 'depthMm', 'checks')
    if (-not (Test-PreparedText $Context.schema 'overdrafter.prepared-assembly.v2') -or
        -not (Test-PreparedText $Context.packageId 'ovd-native04-assembly') -or
        -not (Test-PreparedText $Context.configuration 'Default') -or
        -not (Test-PreparedText $Context.assemblyPath 'synthetic-assembly.SLDASM')) { throw 'Unsupported cumulative context.' }
    Assert-CumulativeScope $Context.scope; Assert-CumulativeUuid $Context.snapshotId; Assert-CumulativeUuid $Context.seedSnapshotId
    Assert-CumulativeInteger $Context.sequence 0; Assert-PreparedTime $Context.createdAt; Assert-CumulativeFiles $Context.files
    if ($Context.sequence -eq 0) {
        if ($Context.snapshotId -cne $Context.seedSnapshotId -or -not (Test-PreparedNumber $Context.depthMm) -or $Context.depthMm -ne 5 -or
            $null -ne $Context.producer -or $Context.checks -isnot [array] -or $Context.checks.Count -ne 0) { throw 'Invalid seed context.' }
        Assert-PreparedFiles $Context.files
    } else {
        Assert-CumulativeDepth $Context.depthMm; Assert-CumulativeChecks $Context.checks
        $origin = $Context.producer
        Assert-PreparedKeys $origin @('jobId', 'attemptId', 'fence', 'inputSnapshotId', 'inputContextSha256', 'requestSha256', 'resultSha256')
        foreach ($value in @($origin.jobId, $origin.attemptId, $origin.inputSnapshotId)) { Assert-CumulativeUuid $value }
        foreach ($value in @($origin.inputContextSha256, $origin.requestSha256, $origin.resultSha256)) { Assert-CumulativeDigest $value }
        Assert-CumulativeInteger $origin.fence 1
        if ($Context.snapshotId -ceq $Context.seedSnapshotId -or $Context.snapshotId -ceq $origin.inputSnapshotId -or
            (($Context.sequence -eq 1) -ne ($origin.inputSnapshotId -ceq $Context.seedSnapshotId))) { throw 'Invalid snapshot lineage.' }
    }
}
# Admission requires the complete ordered check set, before any native work.
function Assert-CumulativeRequiredChecks($RequiredChecks) {
    if ($RequiredChecks -isnot [array] -or $RequiredChecks.Count -ne 7) { throw 'All seven checks required.' }
    for ($i = 0; $i -lt 7; $i++) { if (-not (Test-PreparedText $RequiredChecks[$i] $PreparedChecks[$i])) { throw 'Mandatory check order differs.' } }
}
function Assert-CumulativeJob($Job) {
    Assert-PreparedKeys $Job @('schema', 'scope', 'jobId', 'attemptId', 'fence', 'inputSnapshotId', 'outputSnapshotId',
        'seedSnapshotId', 'sequence', 'contextSha256', 'inputFiles', 'expectedDepthMm', 'dimensionId', 'depthMm', 'configuration', 'createdAt', 'requiredChecks')
    if (-not (Test-PreparedText $Job.schema 'overdrafter.prepared-dimension-job.v2') -or
        -not (Test-PreparedText $Job.dimensionId 'baseline-depth') -or -not (Test-PreparedText $Job.configuration 'Default')) { throw 'Unsupported cumulative job.' }
    Assert-CumulativeScope $Job.scope; Assert-PreparedTime $Job.createdAt; Assert-CumulativeFiles $Job.inputFiles
    foreach ($value in @($Job.jobId, $Job.attemptId, $Job.inputSnapshotId, $Job.outputSnapshotId, $Job.seedSnapshotId)) { Assert-CumulativeUuid $value }
    Assert-CumulativeInteger $Job.fence 1; Assert-CumulativeInteger $Job.sequence 1
    Assert-CumulativeDigest $Job.contextSha256; Assert-CumulativeDepth $Job.depthMm
    if ($Job.sequence -eq 1) {
        if (-not (Test-PreparedNumber $Job.expectedDepthMm) -or $Job.expectedDepthMm -ne 5 -or
            $Job.inputSnapshotId -cne $Job.seedSnapshotId) { throw 'Seed job binding differs.' }
        Assert-PreparedFiles $Job.inputFiles
    } else {
        Assert-CumulativeDepth $Job.expectedDepthMm
        if ($Job.inputSnapshotId -ceq $Job.seedSnapshotId) { throw 'Successor cannot reuse the seed.' }
    }
    if ($Job.outputSnapshotId -ceq $Job.inputSnapshotId -or $Job.outputSnapshotId -ceq $Job.seedSnapshotId) { throw 'Output snapshot must be new.' }
    Assert-CumulativeRequiredChecks $Job.requiredChecks
}
function Assert-CumulativeBinding($Job, $Context, [string]$ContextSha256) {
    Assert-CumulativeJob $Job; Assert-CumulativeContext $Context
    if ($Job.scope.organizationId -cne $Context.scope.organizationId -or $Job.scope.projectId -cne $Context.scope.projectId -or
        $Job.inputSnapshotId -cne $Context.snapshotId -or $Job.seedSnapshotId -cne $Context.seedSnapshotId -or
        $Job.sequence -ne ($Context.sequence + 1) -or $Job.contextSha256 -cne $ContextSha256 -or
        $Job.expectedDepthMm -ne $Context.depthMm -or [DateTime]::Parse($Job.createdAt) -lt [DateTime]::Parse($Context.createdAt)) { throw 'Job/predecessor binding differs.' }
    if ($null -ne $Context.producer -and ($Job.jobId -ceq $Context.producer.jobId -or $Job.attemptId -ceq $Context.producer.attemptId)) { throw 'Successor job/attempt must be new.' }
    Assert-CumulativeSameFiles $Job.inputFiles $Context.files
}
