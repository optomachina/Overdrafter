#requires -Version 5.1
# Inert fixed-deadline check: rejected before any native process or package I/O.
$ErrorActionPreference='Stop'; Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot '../prepared-dimension/test-contract.ps1') | Out-Null
. (Join-Path $PSScriptRoot 'CompanionState.ps1')
. (Join-Path $PSScriptRoot '../attempt-journal/JournalContract.ps1')
. (Join-Path $PSScriptRoot '../file-admission/OwnedProcess.ps1')
$root=Join-Path $env:TEMP ('ovd562-deadline-'+[Guid]::NewGuid().ToString())
[IO.Directory]::CreateDirectory($root) | Out-Null
try {
    $jobPath=Join-Path $root 'job.json'; $contextPath=Join-Path $root 'context.json'
    $bindingPath=Join-Path $root 'binding.json'; $output=Join-Path $root 'output'
    $jobText=$job | ConvertTo-Json -Depth 40 -Compress
    [IO.File]::WriteAllText($jobPath,$jobText,(New-Object Text.UTF8Encoding($false,$true)))
    [IO.File]::WriteAllText($contextPath,'{}',(New-Object Text.UTF8Encoding($false,$true)))
    $binding=[pscustomobject]@{organizationId=$job.scope.organizationId;projectId=$job.scope.projectId;
        workerId=(Id 40);installationId=(Id 41);bootId=(Id 42);taskId=(Id 43);
        attemptId=$job.attemptId;jobId=$job.jobId;fence=$job.fence;
        jobSha256=(Get-JournalDigest $jobText);runtimeAdmissionId=(Id 44)}
    Assert-JournalBinding $binding
    [IO.File]::WriteAllText($bindingPath,($binding | ConvertTo-Json -Compress),(New-Object Text.UTF8Encoding($false,$true)))
    $deadline=[DateTimeOffset]::UtcNow.AddSeconds(1).ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    Start-Sleep -Seconds 2
    $rejected=$false
    try {
        & (Join-Path $PSScriptRoot '../prepared-dimension/run.ps1') -Execute -RequestPath $jobPath `
            -ContextPath $contextPath -PackageRoot (Join-Path $root 'package') -OutputRoot $output `
            -JournalBindingPath $bindingPath -DeadlineAt $deadline -AuthorityPath (Join-Path $root 'authority.json') | Out-Null
    } catch {
        $rejected=$_.Exception.Message -match 'deadline is expired or unbounded'
    }
    if (-not $rejected -or [IO.Directory]::Exists($output)) { throw 'Expired connected deadline did not reject before native setup.' }
    $marker=Join-Path $root 'child-started.txt'
    $command='[IO.File]::WriteAllText('''+$marker+''',''started'')'
    $remaining={ Start-Sleep -Milliseconds 150; throw 'Synthetic deadline crossed during durable launch preparation.' }
    $owned=Invoke-OwnedProcess (Join-Path $PSHOME 'powershell.exe') @('-NoProfile','-NonInteractive','-Command',$command) 5000 (Join-Path $root 'deadline-child') -RemainingMs $remaining
    if ($null -ne $owned.pid -or [IO.File]::Exists($marker) -or
        $owned.error -notmatch 'Synthetic deadline crossed') {
        throw 'Consumed launch budget started an owned child.'
    }
    [pscustomobject]@{schema='overdrafter.companion-task-deadline-test.v1';passed=$true;
        nativeActions=0;network=$false;slowTransferSeconds=2} | ConvertTo-Json
} finally { if ([IO.Directory]::Exists($root)) { [IO.Directory]::Delete($root,$true) } }
