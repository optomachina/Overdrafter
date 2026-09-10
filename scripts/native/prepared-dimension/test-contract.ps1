#requires -Version 5.1
<# Pure protocol checks. Does not load COM, launch native processes or touch CAD. #>
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'WireContract.ps1')
. (Join-Path $PSScriptRoot 'WireContractV2.ps1')
$count = 0
function Copy-ContractValue($Value) {
    $text = $Value | ConvertTo-Json -Depth 40
    # Core 7.5+ otherwise coerces ISO strings into DateTime; Windows 5.1 does not.
    if ((Get-Command ConvertFrom-Json).Parameters.ContainsKey('DateKind')) { return ($text | ConvertFrom-Json -DateKind String) }
    return ($text | ConvertFrom-Json)
}
function Assert-Rejected([scriptblock]$Action) {
    $rejected = $false
    try { & $Action } catch { $rejected = $true }
    if (-not $rejected) { throw 'Expected rejection did not occur.' }
    $script:count++
}
function Id([int]$Value) { return ('12345678-1234-4234-8234-{0:d12}' -f $Value) }
$scope = @{ organizationId = (Id 1); projectId = (Id 2) }
$seed = Copy-ContractValue @{
    schema = 'overdrafter.prepared-assembly.v2'; packageId = 'ovd-native04-assembly'; scope = $scope;
    snapshotId = (Id 3); seedSnapshotId = (Id 3); sequence = 0; producer = $null;
    createdAt = '2026-09-10T00:00:00.000Z'; configuration = 'Default'; assemblyPath = 'synthetic-assembly.SLDASM';
    files = $PreparedFiles; depthMm = 5; checks = @()
}
$contextHash = 'a' * 64
$job = Copy-ContractValue @{
    schema = 'overdrafter.prepared-dimension-job.v2'; scope = $scope; jobId = (Id 10); attemptId = (Id 20); fence = 1;
    inputSnapshotId = (Id 3); outputSnapshotId = (Id 30); seedSnapshotId = (Id 3); sequence = 1;
    contextSha256 = $contextHash; inputFiles = $PreparedFiles; expectedDepthMm = 5; dimensionId = 'baseline-depth';
    depthMm = 8; configuration = 'Default'; createdAt = $seed.createdAt; requiredChecks = $PreparedChecks
}
Assert-CumulativeBinding $job $seed $contextHash; $count++
# Native measurement dictionaries must compare to decoded context records.
Assert-CumulativeSameFiles $PreparedFiles $seed.files; $count++
Assert-Rejected { Assert-CumulativeBinding $job $seed ('b' * 64) }
foreach ($field in @('jobId', 'attemptId', 'inputSnapshotId', 'outputSnapshotId', 'seedSnapshotId')) {
    $bad = Copy-ContractValue $job; $bad.$field = 'not-an-id'
    Assert-Rejected { Assert-CumulativeBinding $bad $seed $contextHash }
}
foreach ($value in @(-1, 0, 1.5, '1')) {
    $bad = Copy-ContractValue $job; $bad.fence = $value
    Assert-Rejected { Assert-CumulativeBinding $bad $seed $contextHash }
}
foreach ($value in @(5, 11, '8', [double]::NaN)) {
    $bad = Copy-ContractValue $job; $bad.depthMm = $value
    Assert-Rejected { Assert-CumulativeBinding $bad $seed $contextHash }
}
$bad = Copy-ContractValue $job; $bad.scope.projectId = Id 99
Assert-Rejected { Assert-CumulativeBinding $bad $seed $contextHash }
$bad = Copy-ContractValue $job; $bad.requiredChecks = @($PreparedChecks[0..5])
Assert-Rejected { Assert-CumulativeBinding $bad $seed $contextHash }
$bad = Copy-ContractValue $seed; $bad.files[0].sha256 = 'b' * 64
Assert-Rejected { Assert-CumulativeContext $bad }
$bad = Copy-ContractValue $seed; $bad.files[0].path = '../unexpected.SLDASM'
Assert-Rejected { Assert-CumulativeContext $bad }

$prior = Copy-ContractValue $seed
foreach ($target in @(8, 9, 7)) {
    $next = Copy-ContractValue $job
    $next.inputSnapshotId = $prior.snapshotId; $next.sequence = $prior.sequence + 1
    $next.expectedDepthMm = $prior.depthMm; $next.depthMm = $target; $next.inputFiles = $prior.files
    $next.jobId = Id (10 + $prior.sequence); $next.attemptId = Id (20 + $prior.sequence); $next.outputSnapshotId = Id (30 + $prior.sequence)
    Assert-CumulativeBinding $next $prior $contextHash; $count++
    $snapshot = Copy-ContractValue $prior
    $snapshot.sequence = $next.sequence; $snapshot.snapshotId = $next.outputSnapshotId; $snapshot.depthMm = $target
    $snapshot.producer = Copy-ContractValue @{
        jobId = $next.jobId; attemptId = $next.attemptId; fence = $next.fence; inputSnapshotId = $next.inputSnapshotId;
        inputContextSha256 = $contextHash; requestSha256 = ('b' * 64); resultSha256 = ('c' * 64)
    }
    $snapshot.checks = @($PreparedChecks | ForEach-Object { Copy-ContractValue @{ id = $_; verdict = 'pass'; evidenceSha256 = ('d' * 64) } })
    $snapshot.files[0].sha256 = ('{0:d64}' -f $target); $snapshot.files[1].sha256 = ('{0:d64}' -f ($target + 10))
    Assert-CumulativeContext $snapshot; $count++
    $bad = Copy-ContractValue $snapshot; $bad.checks[1].verdict = 'fail'
    Assert-Rejected { Assert-CumulativeContext $bad }
    $bad = Copy-ContractValue $snapshot; $bad.producer.inputSnapshotId = $snapshot.snapshotId
    Assert-Rejected { Assert-CumulativeContext $bad }
    $prior = $snapshot
}
# The unchanged v1 wire lane still pins the original scope and bytes.
$v1 = Copy-ContractValue @{
    schema = 'overdrafter.prepared-dimension-job.v1'; jobId = (Id 10); attemptId = (Id 20);
    scope = @{ organizationId = 'local-engineering'; projectId = 'prepared-assembly' };
    contextSha256 = $contextHash; inputFiles = $PreparedFiles; dimensionId = 'baseline-depth'; depthMm = 8;
    configuration = 'Default'; createdAt = $seed.createdAt; requiredChecks = $PreparedChecks
}
Assert-PreparedJob $v1; $count++
Assert-Rejected { Assert-CumulativeJob $v1 }
Assert-Rejected { Assert-PreparedJob $job }
[pscustomobject]@{ outcome = 'passed'; assertions = $count; nativeActions = 0; powershell = $PSVersionTable.PSVersion.ToString() } | ConvertTo-Json
