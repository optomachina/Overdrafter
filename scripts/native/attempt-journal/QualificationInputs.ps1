#requires -Version 5.1
# Shared explicit-qualification preflight: preserve original package admission,
# disjoint fresh-root checks and fail-closed native inventory before file creation.
function New-PreparedQualificationEnvironment([string]$PackageRoot,[string]$OutputRoot,[string]$OrganizationId,[string]$ProjectId,[string]$SourceCommit) {
    Assert-CompanionWindows
    Assert-CumulativeUuid $OrganizationId; Assert-CumulativeUuid $ProjectId
    if ($SourceCommit -cnotmatch '^[0-9a-f]{40}\z') { throw 'An exact qualification source commit is required.' }
    $source=Resolve-PreparedLocalPath $PackageRoot; $root=Resolve-PreparedLocalPath $OutputRoot
    if ($root.Length -gt 45 -or (Test-Path -LiteralPath $root)) { throw 'Use a fresh qualification root of at most 45 characters.' }
    if ($root.Equals($source,[StringComparison]::OrdinalIgnoreCase) -or
        $root.StartsWith($source.TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase) -or
        $source.StartsWith($root.TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Qualification and source must be disjoint.' }
    $files=Measure-PreparedPackage $source -RequireOriginal
    # Enumeration errors are failures, never an empty inventory.
    $inventory=@(Get-Process -ErrorAction Stop)
    try { if (@($inventory | Where-Object {$_.ProcessName -ieq 'SLDWORKS'}).Count -ne 0) { throw 'Existing native processes prevent qualification.' } }
    finally { foreach ($process in $inventory) { $process.Dispose() } }
    New-Item -ItemType Directory -Path $root -ErrorAction Stop | Out-Null
    return [pscustomobject]@{source=$source;root=$root;files=$files}
}

# Create one synthetic request package after the caller has admitted a fresh
# private root and measured the original package. No process or runtime action.
function New-PreparedQualificationInputs([string]$Root,$Files,[string]$OrganizationId,[string]$ProjectId,[string]$SourceCommit) {
    Assert-CumulativeUuid $OrganizationId; Assert-CumulativeUuid $ProjectId
    if ($SourceCommit -cnotmatch '^[0-9a-f]{40}\z') { throw 'An exact qualification source commit is required.' }
    # Cast each measured record, as in Assert-CumulativeSameFiles. Desktop 5.1
    # can reserialize a root-array JSON roundtrip as {value,Count}, not an array.
    # Preserve every field so strict validation still rejects unexpected keys.
    $Files=@($Files | ForEach-Object { [pscustomobject]$_ })
    Assert-PreparedFiles $Files
    $scope=@{organizationId=$OrganizationId;projectId=$ProjectId}; $snapshot=[Guid]::NewGuid().ToString()
    $context=[ordered]@{schema='overdrafter.prepared-assembly.v2';packageId='ovd-native04-assembly';scope=$scope;
        snapshotId=$snapshot;seedSnapshotId=$snapshot;sequence=0;producer=$null;createdAt=[DateTime]::UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'");
        configuration='Default';assemblyPath='synthetic-assembly.SLDASM';files=$files;depthMm=5;checks=@()}
    $contextPath=Join-Path $root 'context.json'; $contextHash=Write-PreparedJson $contextPath $context
    $job=[ordered]@{schema='overdrafter.prepared-dimension-job.v2';scope=$scope;jobId=[Guid]::NewGuid().ToString();attemptId=[Guid]::NewGuid().ToString();
        fence=1;inputSnapshotId=$snapshot;outputSnapshotId=[Guid]::NewGuid().ToString();seedSnapshotId=$snapshot;sequence=1;
        contextSha256=$contextHash;inputFiles=$files;expectedDepthMm=5;dimensionId='baseline-depth';depthMm=8;configuration='Default';
        createdAt=[DateTime]::UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'");requiredChecks=$PreparedChecks}
    $jobPath=Join-Path $root 'job.json'; $jobHash=Write-PreparedJson $jobPath $job
    # Validate the exact serialized request given to the worker. The construction
    # dictionary is not a wire object; preserve timestamp strings on Core as well.
    $job=ConvertFrom-CompanionJson ([Text.Encoding]::UTF8.GetString((Read-PreparedJson $jobPath).bytes))
    $binding=[pscustomobject]@{organizationId=$OrganizationId;projectId=$ProjectId;workerId=[Guid]::NewGuid().ToString();
        installationId=[Guid]::NewGuid().ToString();bootId=[Guid]::NewGuid().ToString();taskId=[Guid]::NewGuid().ToString();
        jobId=$job.jobId;attemptId=$job.attemptId;fence=1;jobSha256=$jobHash;runtimeAdmissionId=[Guid]::NewGuid().ToString()}
    $bindingPath=Join-Path $root 'journal-binding.json'; [void](Write-PreparedJson $bindingPath $binding)
    Assert-PreparedQualificationScope $job $binding $SourceCommit
    return [pscustomobject]@{job=$job;binding=$binding;jobPath=$jobPath;contextPath=$contextPath;bindingPath=$bindingPath}
}
