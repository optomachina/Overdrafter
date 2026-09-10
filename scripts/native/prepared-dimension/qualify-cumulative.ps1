#requires -Version 5.1
<#
.SYNOPSIS
Explicit local qualification of the synthetic 5 -> 8 -> 9 -> 7 mm chain.
.DESCRIPTION
No service authentication is asserted by this experiment. Each child runner
owns one native process. Failure stops the chain and retains all evidence.
No retry, publication, cleanup of existing processes or source mutation.
#>
[CmdletBinding()]
param(
    [switch]$Execute,
    [Parameter(Mandatory = $true)][string]$PackageRoot,
    [Parameter(Mandatory = $true)][string]$OutputRoot,
    [Parameter(Mandatory = $true)][string]$OrganizationId,
    [Parameter(Mandatory = $true)][string]$ProjectId,
    [string]$SourceCommit,
    [switch]$Journal
)
if (-not $Execute) { throw 'Default-off: -Execute is required for this three-job native qualification.' }
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'WireContract.ps1')
. (Join-Path $PSScriptRoot 'WireContractV2.ps1')
. (Join-Path $PSScriptRoot '../file-admission/OwnedProcess.ps1')
if ($Journal) { . (Join-Path $PSScriptRoot '../attempt-journal/QualificationEvidence.ps1') }
if ($PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1 -or
    [Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or -not [Environment]::Is64BitProcess) { throw 'Requires Windows x64 PowerShell 5.1.' }
Assert-CumulativeUuid $OrganizationId; Assert-CumulativeUuid $ProjectId
$source = Resolve-PreparedLocalPath $PackageRoot; $root = Resolve-PreparedLocalPath $OutputRoot
if ($root.Length -gt 45) { throw 'Qualification root must be at most 45 characters.' }
if (Test-Path -LiteralPath $root) { throw 'Qualification output must be a new directory.' }
if ($root.StartsWith($source.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase) -or
    $source.StartsWith($root.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase) -or
    $root.Equals($source, [StringComparison]::OrdinalIgnoreCase)) { throw 'Qualification and source must be disjoint.' }
$seedFiles = Measure-PreparedPackage $source -RequireOriginal
$seedId = [Guid]::NewGuid().ToString()
$scope = @{ organizationId = $OrganizationId; projectId = $ProjectId }
$context = [ordered]@{
    schema = 'overdrafter.prepared-assembly.v2'; packageId = 'ovd-native04-assembly'; scope = $scope;
    snapshotId = $seedId; seedSnapshotId = $seedId; sequence = 0; producer = $null;
    createdAt = [DateTime]::UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'"); configuration = 'Default';
    assemblyPath = 'synthetic-assembly.SLDASM'; files = $seedFiles; depthMm = 5; checks = @()
}
New-Item -ItemType Directory -Path $root -ErrorAction Stop | Out-Null
$history = @(@{ root = $source; files = $seedFiles })
$observations = @(); $steps = @(); $errorMessage = $null
$journalSummaries = @()
$workerId = [Guid]::NewGuid().ToString(); $installationId = [Guid]::NewGuid().ToString()
$bootId = [Guid]::NewGuid().ToString(); $runtimeAdmissionId = [Guid]::NewGuid().ToString()
$powershell = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
try {
    $inputRoot = $source
    foreach ($target in @(8, 9, 7)) {
        $sequence = $context.sequence + 1
        $contextPath = Join-Path $root ('context-' + $sequence + '.json')
        $contextHash = Write-PreparedJson $contextPath $context
        $job = [ordered]@{
            schema = 'overdrafter.prepared-dimension-job.v2'; scope = $scope;
            jobId = [Guid]::NewGuid().ToString(); attemptId = [Guid]::NewGuid().ToString(); fence = 1;
            inputSnapshotId = $context.snapshotId; outputSnapshotId = [Guid]::NewGuid().ToString();
            seedSnapshotId = $seedId; sequence = $sequence; contextSha256 = $contextHash; inputFiles = $context.files;
            expectedDepthMm = $context.depthMm; dimensionId = 'baseline-depth'; depthMm = $target; configuration = 'Default';
            createdAt = [DateTime]::UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'"); requiredChecks = $PreparedChecks
        }
        $jobPath = Join-Path $root ('job-' + $sequence + '.json')
        $jobHash = Write-PreparedJson $jobPath $job
        $parsedJob = Read-PreparedJson $jobPath; $parsedContext = Read-PreparedJson $contextPath
        Assert-CumulativeBinding $parsedJob.value $parsedContext.value $contextHash
        $arguments = @('-NoProfile', '-File', (Join-Path $PSScriptRoot 'run.ps1'), '-Execute', '-RequestPath', $jobPath,
            '-ContextPath', $contextPath, '-PackageRoot', $inputRoot, '-OutputRoot', $root)
        if ($SourceCommit) { $arguments += @('-SourceCommit', $SourceCommit) }
        if ($Journal) {
            # Synthetic qualification labels do not create server admissions.
            $binding = [pscustomobject]@{ organizationId=$OrganizationId; projectId=$ProjectId; workerId=$workerId;
                installationId=$installationId; bootId=$bootId; taskId=[Guid]::NewGuid().ToString();
                jobId=$job.jobId; attemptId=$job.attemptId; fence=$job.fence; jobSha256=$jobHash; runtimeAdmissionId=$runtimeAdmissionId }
            Assert-JournalBinding $binding
            $bindingPath = Join-Path $root ('journal-binding-' + $sequence + '.json')
            [void](Write-PreparedJson $bindingPath $binding)
            $arguments += @('-JournalBindingPath', $bindingPath)
        }
        $observation = Invoke-OwnedProcess $powershell $arguments 600000 (Join-Path $root ('driver-' + $sequence))
        $observations += $observation
        if ($observation.error -or $observation.timedOut -or $observation.exitCode -ne 0) { throw 'Native child failed; stop and reconcile retained evidence/processes.' }
        $attemptRoot = Join-Path $root $job.attemptId
        if ($Journal) {
            $supervisor = (Read-PreparedJson (Join-Path $attemptRoot 'supervisor-final.json')).value
            $journalPath = Join-Path $attemptRoot 'attempt-journal.json'
            $summary = Assert-PreparedJournalEvidence ([IO.File]::ReadAllText($journalPath)) $supervisor $binding (Get-PreparedHash $journalPath)
            $journalSummaries += @{ attemptId=$job.attemptId; sha256=$supervisor.journal.sha256; summary=$summary }
        }
        # Fresh helper process, with no dimension settings: exercise the exact
        # default reader used by AssemblyRecovery. This does not invoke CAD.
        $reader = Invoke-OwnedProcess (Join-Path $attemptRoot 'PreparedDimensionProbe.exe') @('--check-pinned-inputs', $source) 30000 (Join-Path $root ('seed-reader-' + $sequence))
        $observations += $reader
        if ($reader.error -or $reader.timedOut -or $reader.exitCode -ne 0) { throw 'Pinned recovery reader regression.' }
        $readerResult = $reader.stdout | ConvertFrom-Json
        if ($readerResult.outcome -cne 'passed' -or $readerResult.mode -cne 'pinned_input_files_only') { throw 'Pinned reader receipt differs.' }
        $receipt = Read-PreparedJson (Join-Path $attemptRoot 'result.json'); $result = $receipt.value
        Assert-PreparedKeys $result @('schema', 'scope', 'jobId', 'attemptId', 'fence', 'inputSnapshotId', 'outputSnapshotId',
            'requestSha256', 'contextSha256', 'depthMm', 'outcome', 'failureReason', 'inputFiles', 'outputFiles',
            'checks', 'measurements', 'candidateRoot', 'completedAt', 'adoption')
        if ($result.schema -cne 'overdrafter.prepared-dimension-result.v2' -or $result.outcome -cne 'succeeded' -or
            $null -ne $result.failureReason -or $result.adoption -cne 'unadopted' -or $result.requestSha256 -cne $jobHash -or
            $result.scope.organizationId -cne $OrganizationId -or $result.scope.projectId -cne $ProjectId) { throw 'Native receipt identity/outcome differs.' }
        foreach ($key in @('jobId', 'attemptId', 'fence', 'inputSnapshotId', 'outputSnapshotId', 'contextSha256', 'depthMm')) {
            if ($result.$key -cne $job.$key) { throw ('Native receipt binding differs: ' + $key) }
        }
        Assert-CumulativeChecks $result.checks
        Assert-CumulativeSameFiles $result.inputFiles $context.files
        Assert-PreparedTime $result.completedAt
        if ([DateTime]::Parse($result.completedAt) -lt [DateTime]::Parse($job.createdAt)) { throw 'Native receipt time differs.' }
        Assert-PreparedKeys $result.measurements @('beforeDepthMm', 'afterDepthMm', 'beforeVolumeMm3', 'afterVolumeMm3')
        foreach ($measure in @(@('beforeDepthMm', $context.depthMm, 1e-7), @('afterDepthMm', $target, 1e-7),
            @('beforeVolumeMm3', ([Math]::PI * 100 * $context.depthMm), 0.1), @('afterVolumeMm3', ([Math]::PI * 100 * $target), 0.1))) {
            if (-not (Test-PreparedNumber $result.measurements.($measure[0])) -or
                [Math]::Abs($result.measurements.($measure[0]) - $measure[1]) -gt $measure[2]) { throw 'Native measured geometry differs.' }
        }
        $candidate = Join-Path $attemptRoot 'candidate'
        if ($result.candidateRoot -ine $candidate) { throw 'Candidate path differs.' }
        $outputs = Measure-PreparedPackage $candidate
        Assert-CumulativeSameFiles $result.outputFiles $outputs
        if ($outputs[1].sha256 -ceq $context.files[1].sha256) { throw 'Changed depth has unchanged native bytes.' }
        foreach ($check in $result.checks) {
            $name = 'native-dimension.stdout.txt'
            if ($check.id -ceq 'input_identity') { $name = 'input-identity.json' }
            elseif ($check.id -ceq 'source_preservation') { $name = 'source-preservation.json' }
            if ((Get-PreparedHash (Join-Path $attemptRoot $name)) -cne $check.evidenceSha256) { throw 'Mandatory evidence bytes differ.' }
        }
        foreach ($prior in $history) {
            $measured = Measure-PreparedPackage $prior.root
            Assert-CumulativeSameFiles $measured $prior.files
        }
        $history += @{ root = $candidate; files = $outputs }
        $steps += @{ jobId = $job.jobId; attemptId = $job.attemptId; before = $context.depthMm; after = $target;
            resultSha256 = $receipt.sha256; inputContextSha256 = $contextHash; priorPackagesPreserved = $history.Count - 1 }
        $context = [ordered]@{
            schema = 'overdrafter.prepared-assembly.v2'; packageId = 'ovd-native04-assembly'; scope = $scope;
            snapshotId = $job.outputSnapshotId; seedSnapshotId = $seedId; sequence = $sequence;
            producer = @{ jobId = $job.jobId; attemptId = $job.attemptId; fence = $job.fence;
                inputSnapshotId = $job.inputSnapshotId; inputContextSha256 = $contextHash; requestSha256 = $jobHash; resultSha256 = $receipt.sha256 };
            createdAt = $result.completedAt; configuration = 'Default'; assemblyPath = 'synthetic-assembly.SLDASM';
            files = $outputs; depthMm = $target; checks = $result.checks
        }
        $inputRoot = $candidate
    }
    [void](Write-PreparedJson (Join-Path $root 'final-context.json') $context)
} catch { $errorMessage = $_.Exception.Message }
$outcome = 'failed'; if ($null -eq $errorMessage -and $steps.Count -eq 3) { $outcome = 'passed' }
[void](Write-PreparedJson (Join-Path $root 'qualification.json') (@{
    schema = 'overdrafter.cumulative-qualification.v1'; outcome = $outcome; steps = $steps;
    observations = $observations; journals = $journalSummaries; error = $errorMessage; authenticatedWorker = $false;
    limitation = 'Operator qualification only. Not a deployed coordinator, tenant authorization or release approval.'
}))
if ($outcome -ne 'passed') { throw $errorMessage }
Write-Output (Join-Path $root 'qualification.json')
