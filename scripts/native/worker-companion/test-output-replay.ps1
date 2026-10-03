#requires -Version 5.1
# Inert protocol test. No paired store, network, native process or real credentials.
$ErrorActionPreference='Stop'; Set-StrictMode -Version Latest
foreach ($module in @('CompanionState','CompanionStore','CompanionTask','CompanionArtifact','CompanionOutputReplay')) {
    . (Join-Path $PSScriptRoot ($module+'.ps1'))
}
$script:checks=0
function Check([bool]$Condition,[string]$Label) { $script:checks++; if (-not $Condition) { throw ('Output replay check failed: '+$Label) } }
function Must-Fail([scriptblock]$Action,[string]$Label) {
    $failed=$false; try { & $Action | Out-Null } catch { $failed=$true }; Check $failed $Label
}
function U([int]$N) { return '56200000-0000-4000-8000-'+$N.ToString('000000000000') }
foreach ($file in @('CompanionOutputReplay.ps1','replay-output.ps1','run-task.ps1','test-output-replay.ps1')) {
    $errors=$null; $tokens=$null
    $null=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot $file),[ref]$tokens,[ref]$errors)
    Check (@($errors).Count -eq 0) ('parse '+$file)
}
Must-Fail { & (Join-Path $PSScriptRoot 'replay-output.ps1') } 'entrypoint is default off'
Must-Fail { & (Join-Path $PSScriptRoot 'replay-output.ps1') -Connect } 'connect alone is not replay consent'
Must-Fail { & (Join-Path $PSScriptRoot 'replay-output.ps1') -ReplayOutput } 'replay flag alone is not connection consent'
$state=[pscustomobject]@{workerId=(U 1);installationId=(U 2);bootId=(U 3);
    gatewayUrl='https://example.invalid/functions/v1/engineering-worker';token='inert-never-sent'}
$status=[pscustomobject]@{sessionId=(U 4);reason='enabled'}
$context=[pscustomobject]@{snapshotId=(U 5);scope=[pscustomobject]@{organizationId=(U 6);projectId=(U 7)};producer=$null}
$contextText=$context | ConvertTo-Json -Depth 5 -Compress
$job=[pscustomobject]@{schema='overdrafter.prepared-dimension-job.v2';attemptId=(U 8);fence=9;
    contextSha256=(Get-CompanionTextHash $contextText);inputSnapshotId=(U 5);outputSnapshotId=(U 10);scope=$context.scope}
$jobText=$job | ConvertTo-Json -Depth 5 -Compress
$claim=[pscustomobject]@{taskId=(U 11);workerId=$state.workerId;bootId=$state.bootId;installationId=$state.installationId;
    sessionId=$status.sessionId;attemptId=$job.attemptId;fence=$job.fence;
    jobText=$jobText;jobSha256=(Get-CompanionTextHash $jobText);contextText=$contextText;contextSha256=$job.contextSha256}
$task=[pscustomobject]@{schema='overdrafter.companion-task.v1';workerId=$state.workerId;bootId=$state.bootId;
    taskId=$claim.taskId;runtimeAdmissionId=(U 12);inputAdmissionId=(U 13);phase='recovery_required';pending=$null;heartbeat=$null;receipt=$claim}
$payloads=@{}; $files=@()
foreach ($role in @('assembly','target','companion','result','identity','preservation','native')) {
    $bytes=[Text.Encoding]::UTF8.GetBytes('synthetic '+$role)
    $payloads[$role]=$bytes
    $files+=@([pscustomobject]@{role=$role;bytes=$bytes.Length;sha256=(Get-CompanionSha256 $bytes)})
}
$descriptor=[pscustomobject]@{schema='overdrafter.companion-output-replay.v1';gatewayUrl=$state.gatewayUrl;
    scope=(Get-CompanionOutputScope $task);files=$files}
$script:reads=0; $script:sends=0; $script:drop=$true; $script:seen=@{}
$read={param($attempt,$file)
    Check ($attempt -ceq $claim.attemptId) 'reader receives original attempt'
    $script:reads++; return ,$payloads[$file.role]
}
$transport={param($direction,$headers,$content,$token,$url)
    Check ($script:reads -ge 7) 'all spools preflight before first PUT'
    Check ($direction -ceq 'output' -and $token -ceq $state.token -and
        $url -ceq 'https://example.invalid/functions/v1/engineering-worker-artifact') 'output transport only'
    $scope=ConvertFrom-CompanionJson $headers['x-overdrafter-scope']
    Check ($scope.attemptId -ceq $claim.attemptId -and $scope.fence -eq $claim.fence) 'original fence and attempt'
    $role=$headers['x-overdrafter-role']; $script:sends++
    $request=($headers | ConvertTo-Json -Compress)+(Get-CompanionSha256 $content)
    if ($script:seen.ContainsKey($role)) { Check ($script:seen[$role] -ceq $request) 'identical request after lost response' }
    else { $script:seen[$role]=$request }
    if ($role -ceq 'result' -and $script:drop) { $script:drop=$false; throw 'synthetic response loss after commit' }
    return [pscustomobject]@{status=200;redirected=$false;body=[pscustomobject]@{
        schema='overdrafter.native-artifact-transfer.v1';delivered=$true;role=$role}}
}
$original=$task | ConvertTo-Json -Depth 8 -Compress
Must-Fail { Invoke-CompanionOutputReplay $descriptor $task $state $status $read $transport } 'lost fourth output reply stays unresolved'
Check ($script:sends -eq 4) 'no later transfer after uncertain response'
$reply=Invoke-CompanionOutputReplay $descriptor $task $state $status $read $transport
Check ($script:sends -eq 11 -and $reply.phase -ceq 'outputs_delivered' -and $reply.deliveredRoles -eq 7) 'one full exact replay recovers delivery'
Check (-not $reply.nativeExecutionAttempted -and -not $reply.resultEligible -and $reply.stopAdmissionPending) 'delivery grants no native or result authority'
Check (($task | ConvertTo-Json -Depth 8 -Compress) -ceq $original) 'task state is untouched'
foreach ($reason in @('paused','expired')) {
    $drain=[pscustomobject]@{sessionId=$status.sessionId;reason=$reason}
    $null=Invoke-CompanionOutputReplay $descriptor $task $state $drain $read $transport
}
$before=$script:sends
$revoked=[pscustomobject]@{sessionId=$status.sessionId;reason='revoked'}
Must-Fail { Invoke-CompanionOutputReplay $descriptor $task $state $revoked $read $transport } 'revoked session denied'
foreach ($field in @('attemptId','taskId','bootId','sessionId','candidateSnapshotId','predecessorAttemptId','organizationId')) {
    $wrong=Copy-CompanionRecord $descriptor; $wrong.scope.$field=U 99
    Must-Fail { Invoke-CompanionOutputReplay $wrong $task $state $status $read $transport } ('foreign '+$field+' denied')
}
$wrong=Copy-CompanionRecord $descriptor; $wrong.scope.fence++
Must-Fail { Invoke-CompanionOutputReplay $wrong $task $state $status $read $transport } 'changed fence denied'
$wrong=Copy-CompanionRecord $descriptor; $wrong.gatewayUrl='https://other.invalid/functions/v1/engineering-worker'
Must-Fail { Invoke-CompanionOutputReplay $wrong $task $state $status $read $transport } 'changed endpoint denied'
$wrong=Copy-CompanionRecord $descriptor; $wrong.files[6].role='result'
Must-Fail { Invoke-CompanionOutputReplay $wrong $task $state $status $read $transport } 'duplicate role denied'
$wrong=Copy-CompanionRecord $descriptor; $wrong.files=$wrong.files[0..5]
Must-Fail { Invoke-CompanionOutputReplay $wrong $task $state $status $read $transport } 'incomplete descriptor denied'
$badReader={param($attempt,$file) if ($file.role -ceq 'native') { return ,[byte[]]@(1) }; return ,$payloads[$file.role]}
Must-Fail { Invoke-CompanionOutputReplay $descriptor $task $state $status $badReader $transport } 'corrupt last spool denied before any send'
$missingReader={param($attempt,$file) if ($file.role -ceq 'native') { throw 'missing spool' }; return ,$payloads[$file.role]}
Must-Fail { Invoke-CompanionOutputReplay $descriptor $task $state $status $missingReader $transport } 'missing spool has no source fallback'
Check ($script:sends -eq $before) 'all denied cases sent zero requests'
# On admitted Windows 5.1 only, exercise immutable disk persistence in a fresh
# fixture directory. This never opens the real companion store or DPAPI state.
$disk=$false
if ($PSVersionTable.PSEdition -ceq 'Desktop') {
    Assert-CompanionWindows
    $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
    try { $sid=$identity.User } finally { $identity.Dispose() }
    $root=Join-Path $env:TEMP ('ovd562-output-replay-'+[Guid]::NewGuid().ToString())
    (New-Object IO.DirectoryInfo($root)).Create((New-CompanionAcl $sid $true))
    $lock=$null
    try {
        $lock=New-CompanionPrivateFile (Join-Path $root 'owner.lock') $sid
        $store=[pscustomobject]@{root=$root;sid=$sid;lock=$lock;workerId=$state.workerId}
        $candidate=Join-Path $root 'candidate'
        (New-Object IO.DirectoryInfo($candidate)).Create((New-CompanionAcl $sid $true))
        $paths=@()
        foreach ($file in $files) {
            $path=Join-Path $candidate ($file.role+'.synthetic')
            $stream=New-CompanionPrivateFile $path $sid
            $bytes=$payloads[$file.role]
            try { $stream.Write($bytes,0,$bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
            $paths+=@($path)
        }
        $incomplete=[string[]]$paths.Clone()
        $incomplete[6]=Join-Path $candidate 'missing.synthetic'
        $before=$script:sends
        Must-Fail { Save-CompanionOutputReplay $store $task $state $status $candidate $incomplete } 'incomplete staging fails without sending'
        Must-Fail { Read-CompanionOutputReplay $store $claim.attemptId } 'partial spools cannot substitute for descriptor'
        Check ($script:sends -eq $before) 'incomplete staging sends no requests'
        $saved=Save-CompanionOutputReplay $store $task $state $status $candidate $paths
        Check ($saved.files.Count -eq 7) 'complete descriptor persisted'
        $reloaded=Read-CompanionOutputReplay $store $claim.attemptId
        foreach ($path in $paths) { [IO.File]::Delete($path) }
        $diskReader={param($attempt,$file) Read-CompanionOutputBytes $store $attempt $file}
        $reply=Invoke-CompanionOutputReplay $reloaded $task $state $status $diskReader $transport
        Check ($reply.deliveredRoles -eq 7) 'reloaded descriptor replays with all candidate sources deleted'
        Must-Fail { Save-CompanionOutputReplay $store $task $state $status $candidate $paths } 'immutable descriptor cannot be replaced'
        $spool=Join-Path $root ('artifact-'+$claim.attemptId+'-native.bin')
        [IO.File]::WriteAllBytes($spool,[byte[]]@(1))
        $before=$script:sends
        Must-Fail { Invoke-CompanionOutputReplay $reloaded $task $state $status $diskReader $transport } 'corrupt real spool fails closed'
        Check ($script:sends -eq $before) 'disk corruption prevents all transfers'
        $disk=$true
    } finally {
        if ($null -ne $lock) { $lock.Dispose() }
        if ([IO.Directory]::Exists($root)) { [IO.Directory]::Delete($root,$true) }
    }
}
[pscustomobject]@{schema='overdrafter.companion-output-replay-test.v1';checks=$script:checks;
    passed=$true;disk=$disk;network=$false;nativeActions=0;powershell=$PSVersionTable.PSVersion.ToString()} | ConvertTo-Json
