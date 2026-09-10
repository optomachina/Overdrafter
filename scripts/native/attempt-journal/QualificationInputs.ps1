#requires -Version 5.1
# Create one synthetic request package after the caller has admitted a fresh
# private root and measured the original package. No process or runtime action.
function New-PreparedQualificationInputs([string]$Root,$Files,[string]$OrganizationId,[string]$ProjectId,[string]$SourceCommit) {
    Assert-CumulativeUuid $OrganizationId; Assert-CumulativeUuid $ProjectId
    if ($SourceCommit -cnotmatch '^[0-9a-f]{40}\z') { throw 'An exact qualification source commit is required.' }
    # The measured package supplies ordered dictionaries. Cross the wire
    # boundary before applying strict object validation, just as for the job.
    $Files=ConvertFrom-CompanionJson (ConvertTo-Json -InputObject $Files -Depth 10 -Compress)
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
