#requires -Version 5.1
<# Synthetic JSON and exchange-envelope checks only; no CAD, COM or network. #>
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../prepared-dimension/WireContract.ps1')
. (Join-Path $PSScriptRoot '../prepared-dimension/WireContractV2.ps1')
. (Join-Path $PSScriptRoot 'PreviewContract.ps1')
. (Get-PreviewRuntimeFunctions (Join-Path $PSScriptRoot '../prepared-dimension/run.ps1'))
$count = 0
$root = Join-Path ([IO.Path]::GetTempPath()) ('ovd502-contract-' + [Guid]::NewGuid().ToString('N'))
$oldDefaults = $PSDefaultParameterValues.Clone()
if ((Get-Command ConvertFrom-Json).Parameters.ContainsKey('DateKind')) { $PSDefaultParameterValues['ConvertFrom-Json:DateKind'] = 'String' }
function Id([int]$Value) { return ('12345678-1234-4234-8234-{0:d12}' -f $Value) }
function Copy-Value($Value) { return ($Value | ConvertTo-Json -Depth 40 | ConvertFrom-Json) }
function Assert-True($Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
    $script:count++
}
function Assert-Rejected([scriptblock]$Action) {
    $rejected = $false
    try { & $Action | Out-Null } catch { $rejected = $true }
    Assert-True $rejected 'Expected rejection did not occur.'
}
function Save-Context($Value) {
    $path = Join-Path $root ([Guid]::NewGuid().ToString('N') + '.json')
    [void](Write-PreparedJson $path $Value)
    return $path
}
try {
    [void][IO.Directory]::CreateDirectory($root)
    $seed = Copy-Value @{
        schema = 'overdrafter.prepared-assembly.v2'; packageId = 'ovd-native04-assembly';
        scope = @{ organizationId = (Id 1); projectId = (Id 2) }; snapshotId = (Id 3); seedSnapshotId = (Id 3);
        sequence = 0; producer = $null; createdAt = '2026-09-10T00:00:00.000Z'; configuration = 'Default';
        assemblyPath = 'synthetic-assembly.SLDASM'; files = $PreparedFiles; depthMm = 5; checks = @()
    }
    $v1 = Copy-Value @{
        schema = 'overdrafter.prepared-assembly.v1'; packageId = 'ovd-native04-assembly';
        scope = @{ organizationId = 'local-engineering'; projectId = 'prepared-assembly' };
        capturedAt = $seed.createdAt; configuration = 'Default'; assemblyPath = 'synthetic-assembly.SLDASM'; files = $PreparedFiles;
        dimension = @{ id = 'baseline-depth'; occurrence = 'baseline-5mm-1'; feature = 'OVD_QualificationExtrusion';
            partPath = 'parts/baseline-5mm.SLDPRT'; unit = 'mm'; baseline = 5; minimum = 6; maximum = 10 };
        limitations = $PreparedLimitations
    }
    $step = [Text.Encoding]::ASCII.GetBytes('ISO-10303-21;HEADER;ENDSEC;DATA;ENDSEC;END-ISO-10303-21;')
    $v1Binding = Read-PreviewBinding 'baseline' (Save-Context $v1) '' '' $root
    $v1Bundle = [Text.Encoding]::UTF8.GetString((New-PreviewBundle $v1Binding $step ('a' * 64) $null)) | ConvertFrom-Json
    Assert-True ($v1Bundle.schema -ceq 'overdrafter.prepared-step-preview.v1') 'V1 bundle schema changed.'
    Assert-True ($v1Bundle.PSObject.Properties.Name -cnotcontains 'snapshotId') 'V2 authority leaked into v1.'

    $path = Save-Context $seed
    $binding = Read-PreviewBinding 'baseline' $path '' '' $root
    $bundle = [Text.Encoding]::UTF8.GetString((New-PreviewBundle $binding $step ('a' * 64) $null)) | ConvertFrom-Json
    Assert-True ($bundle.schema -ceq 'overdrafter.prepared-step-preview.v2' -and $bundle.snapshotId -ceq $seed.snapshotId) 'Seed snapshot binding missing.'
    Assert-True ($bundle.contextSha256 -ceq (Get-PreparedHash $path) -and $bundle.scope.organizationId -ceq $seed.scope.organizationId) 'Seed byte/scope binding differs.'
    Assert-True ($null -eq $bundle.requestSha256 -and $null -eq $bundle.resultSha256) 'Seed claims a producer.'
    Assert-Rejected { Read-PreviewBinding 'candidate' $path '' '' $root }
    Assert-Rejected { Read-PreviewBinding 'baseline' $path 'request.json' '' $root }

    $candidate = Copy-Value $seed
    $candidate.snapshotId = Id 5; $candidate.sequence = 2; $candidate.depthMm = 9
    $candidate.files[0].sha256 = 'b' * 64; $candidate.files[1].sha256 = 'c' * 64
    $candidate.producer = Copy-Value @{ jobId = (Id 6); attemptId = (Id 7); fence = 2; inputSnapshotId = (Id 4);
        inputContextSha256 = ('d' * 64); requestSha256 = ('e' * 64); resultSha256 = ('f' * 64) }
    $candidate.checks = @($PreparedChecks | ForEach-Object { Copy-Value @{ id = $_; verdict = 'pass'; evidenceSha256 = ('a' * 64) } })
    foreach ($depth in @(9, 7)) {
        $candidate.depthMm = $depth
        $path = Save-Context $candidate
        $binding = Read-PreviewBinding 'candidate' $path '' '' $root
        $bundle = [Text.Encoding]::UTF8.GetString((New-PreviewBundle $binding $step ('a' * 64) ('b' * 40))) | ConvertFrom-Json
        Assert-True ($binding.depthMm -eq $depth -and $bundle.snapshotId -ceq $candidate.snapshotId) 'Candidate actual depth/snapshot differs.'
        Assert-True ($bundle.requestSha256 -ceq $candidate.producer.requestSha256 -and $bundle.resultSha256 -ceq $candidate.producer.resultSha256) 'Candidate producer differs.'
        Assert-True ($bundle.nativeFiles[1].sha256 -ceq $candidate.files[1].sha256 -and $bundle.contextSha256 -ceq (Get-PreparedHash $path)) 'Candidate bytes differ.'
        Assert-Rejected { Read-PreviewBinding 'baseline' $path '' '' $root }
        Assert-Rejected { Read-PreviewBinding 'candidate' $path '' 'result.json' $root }
    }
    foreach ($field in @('snapshotId', 'sequence', 'depthMm', 'producer', 'checks', 'files', 'scope')) {
        $bad = Copy-Value $candidate; $bad.$field = $null
        $badPath = Save-Context $bad
        Assert-Rejected { Read-PreviewBinding 'candidate' $badPath '' '' $root }
    }
    $bad = Copy-Value $candidate; $bad.checks[0].verdict = 'fail'
    $badPath = Save-Context $bad; Assert-Rejected { Read-PreviewBinding 'candidate' $badPath '' '' $root }
    $bad = Copy-Value $candidate; $bad.files[2].sha256 = 'a' * 64
    $badPath = Save-Context $bad; Assert-Rejected { Read-PreviewBinding 'candidate' $badPath '' '' $root }
    Assert-Rejected { New-PreviewBundle $binding $step ('a' * 64) 'not-a-commit' }
    Assert-Rejected { New-PreviewBundle $binding ([byte[]]@()) ('a' * 64) $null }
    Assert-Rejected { New-PreviewBundle $binding ([byte[]]::new(2000001)) ('a' * 64) $null }
    Assert-Rejected { New-PreviewBundle $binding ([Text.Encoding]::ASCII.GetBytes('ISO-10303-21;')) ('a' * 64) $null }
    [ordered]@{ schema = 'overdrafter.cumulative-preview-contract-test.v1'; passed = $true; assertions = $count;
        nativeActions = 0; runtime = $PSVersionTable.PSVersion.ToString() } | ConvertTo-Json -Compress
} finally {
    $PSDefaultParameterValues = $oldDefaults
    if ([IO.Directory]::Exists($root)) { [IO.Directory]::Delete($root, $true) }
}
exit 0
