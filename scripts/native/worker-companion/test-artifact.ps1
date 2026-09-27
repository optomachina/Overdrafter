#requires -Version 5.1
# Inert companion protocol tests. No filesystem, credential, network or CAD use.
$ErrorActionPreference='Stop'; Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'CompanionState.ps1')
. (Join-Path $PSScriptRoot 'CompanionArtifact.ps1')
. (Join-Path $PSScriptRoot 'CompanionStore.ps1')
$script:assertions=0
function Check([bool]$Condition,[string]$Label) {
    $script:assertions++; if (-not $Condition) { throw ('Assertion failed: '+$Label) }
}
function Must-Fail([scriptblock]$Action,[string]$Label) {
    $failed=$false; try { & $Action | Out-Null } catch { $failed=$true }; Check $failed $Label
}
function U([int]$N) { return '51900000-0000-4000-8000-'+$N.ToString('000000000000') }
$state=[pscustomobject]@{workerId=(U 1);installationId=(U 2);bootId=(U 3);
    gatewayUrl='https://example.invalid/functions/v1/engineering-worker';token=('odw_'+('a'*64))}
$status=[pscustomobject]@{sessionId=(U 4);sessionEligible=$true;reason='enabled'}
$scope=[pscustomobject][ordered]@{organizationId=(U 5);projectId=(U 6);workerId=$state.workerId;
    installationId=$state.installationId;bootId=$state.bootId;sessionId=$status.sessionId;
    taskId=(U 7);attemptId=(U 8);fence=9;inputSnapshotId=(U 10);
    candidateSnapshotId=(U 11);predecessorAttemptId=(U 12)}
$bytes=[Text.Encoding]::UTF8.GetBytes('{"candidate":"synthetic"}')
$digest=Get-CompanionSha256 $bytes
$script:sends=0; $script:saved=$null; $script:drop=$true
$transport={param($direction,$headers,$content,$token,$url)
    Check ($direction -ceq 'output' -and $headers['x-overdrafter-role'] -ceq 'result') 'output role fixed'
    Check ($headers['x-overdrafter-scope'] -match [regex]::Escape($scope.attemptId)) 'attempt retained'
    Check ($token -ceq $state.token -and $url -ceq 'https://example.invalid/functions/v1/engineering-worker-artifact') 'token and endpoint fixed'
    $script:sends++
    if ($null -eq $script:saved) { $script:saved=[byte[]]$content.Clone() }
    else { Check ((Get-CompanionSha256 $content) -ceq (Get-CompanionSha256 $script:saved)) 'retry sends same bytes' }
    if ($script:drop) { $script:drop=$false; throw 'synthetic lost reply' }
    return [pscustomobject]@{status=200;redirected=$false;body=[pscustomobject]@{
        schema='overdrafter.native-artifact-transfer.v1';delivered=$true;role='result'}}
}
Must-Fail { Invoke-CompanionArtifactTransfer $state $status $scope 'output' '' 'result' $bytes $bytes.Length $digest $transport } 'lost reply remains uncertain'
Check ($script:sends -eq 1) 'first output was sent once'
Check (Invoke-CompanionArtifactTransfer $state $status $scope 'output' '' 'result' $script:saved $bytes.Length $digest $transport) 'retained bytes replay succeeds'
Check ($script:sends -eq 2) 'one exact replay'
$paused=[pscustomobject]@{sessionId=$status.sessionId;sessionEligible=$false;reason='paused'}
Check (Invoke-CompanionArtifactTransfer $state $paused $scope 'output' '' 'result' $script:saved $bytes.Length $digest $transport) 'owned output can drain after pause'
$expired=[pscustomobject]@{sessionId=$status.sessionId;sessionEligible=$false;reason='expired'}
Check (Invoke-CompanionArtifactTransfer $state $expired $scope 'output' '' 'result' $script:saved $bytes.Length $digest $transport) 'owned output can drain after expiry'
$newBoot=[pscustomobject]@{sessionId=$status.sessionId;sessionEligible=$false;reason='boot_mismatch'}
Must-Fail { Invoke-CompanionArtifactTransfer $state $newBoot $scope 'output' '' 'result' $script:saved $bytes.Length $digest $transport } 'boot mismatch cannot drain'
$wrong=Copy-CompanionRecord $scope; $wrong.sessionId=U 99
Must-Fail { Invoke-CompanionArtifactTransfer $state $status $wrong 'output' '' 'result' $bytes $bytes.Length $digest $transport } 'foreign session rejected'
$wrong=Copy-CompanionRecord $scope; $wrong.predecessorAttemptId=U 99
$refusal={param($direction,$headers,$content,$token,$url) throw 'server denied predecessor'}
Must-Fail { Invoke-CompanionArtifactTransfer $state $status $wrong 'output' '' 'result' $bytes $bytes.Length $digest $refusal } 'server rejects predecessor'
Must-Fail { Invoke-CompanionArtifactTransfer $state $status $scope 'output' '' 'result' $bytes $bytes.Length ('0'*64) $transport } 'digest mismatch before network'
Must-Fail { Invoke-CompanionArtifactTransfer $state $status $scope 'output' '' 'result' $bytes 256001 $digest $transport } 'result role bound before network'
$redirect={param($direction,$headers,$content,$token,$url) return [pscustomobject]@{status=302;redirected=$true;body=$null}}
Must-Fail { Invoke-CompanionArtifactTransfer $state $status $scope 'output' '' 'result' $bytes $bytes.Length $digest $redirect } 'redirect refused'
$input=[Text.Encoding]::UTF8.GetBytes('exact prepared input')
$inputTransport={param($direction,$headers,$content,$token,$url)
    Check ($direction -ceq 'input' -and $headers['x-overdrafter-artifact-id'] -ceq (U 13)) 'opaque input identity'
    return [pscustomobject]@{status=200;redirected=$false;bytes=$input}}
$received=Invoke-CompanionArtifactTransfer $state $status $scope 'input' (U 13) '' $null $input.Length (Get-CompanionSha256 $input) $inputTransport
Check ((Get-CompanionSha256 $received) -ceq (Get-CompanionSha256 $input)) 'input bytes measured'
Must-Fail { Invoke-CompanionArtifactTransfer $state $status $scope 'input' '../foreign' '' $null $input.Length (Get-CompanionSha256 $input) $inputTransport } 'foreign path refused'
if ($PSVersionTable.PSEdition -ceq 'Desktop') {
    Assert-CompanionWindows
    $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
    try { $sid=$identity.User } finally { $identity.Dispose() }
    $root=Join-Path $env:TEMP ('ovd519-artifact-'+[Guid]::NewGuid().ToString())
    $rootInfo=New-Object IO.DirectoryInfo($root)
    $rootInfo.Create((New-CompanionAcl $sid $true))
    $lock=$null
    try {
        $lock=New-CompanionPrivateFile (Join-Path $root 'owner.lock') $sid
        $store=[pscustomobject]@{root=$root;sid=$sid;lock=$lock;workerId=$state.workerId}
        $candidate=Join-Path $root 'candidate'
        (New-Object IO.DirectoryInfo($candidate)).Create((New-CompanionAcl $sid $true))
        $source=Join-Path $candidate 'synthetic-result.json'
        $file=New-CompanionPrivateFile $source $sid
        try { $file.Write($bytes,0,$bytes.Length); $file.Flush($true) } finally { $file.Dispose() }
        $interrupted=Join-Path $root ([Guid]::NewGuid().ToString()+'.artifact.pending')
        $partial=New-CompanionPrivateFile $interrupted $sid
        try { $partial.Write($bytes,0,1); $partial.Flush($true) } finally { $partial.Dispose() }
        Check (-not [IO.File]::Exists((Join-Path $root ('artifact-'+$scope.attemptId+'-result.bin')))) 'interrupted temporary did not publish final output'
        $first=Save-CompanionArtifactSnapshot $store $scope.attemptId 'result' $candidate $source $bytes.Length $digest
        Check ((Get-CompanionSha256 $first) -ceq $digest) 'private output snapshot measured'
        Check ([IO.File]::Exists($interrupted)) 'interrupted temporary evidence retained after retry'
        [IO.File]::WriteAllBytes($source,[Text.Encoding]::UTF8.GetBytes('changed source'))
        $retry=Save-CompanionArtifactSnapshot $store $scope.attemptId 'result' $candidate $source $bytes.Length $digest
        Check ((Get-CompanionSha256 $retry) -ceq $digest) 'retry reads immutable spool after source changed'
        Must-Fail { Save-CompanionArtifactSnapshot $store $scope.attemptId 'result' (Join-Path $root 'other') $source $bytes.Length $digest } 'foreign candidate root rejected'
        $savedInput=Save-CompanionInputSnapshot $store $scope.attemptId (U 13) $input $input.Length (Get-CompanionSha256 $input)
        Check ([IO.File]::Exists($savedInput)) 'input retained under protected worker directory'
        $changed=[Text.Encoding]::UTF8.GetBytes('changed prepared input')
        Must-Fail { Save-CompanionInputSnapshot $store $scope.attemptId (U 13) $changed $changed.Length (Get-CompanionSha256 $changed) } 'input identity cannot be replaced'
    } finally {
        if ($null -ne $lock) { $lock.Dispose() }
        if ([IO.Directory]::Exists($root)) { [IO.Directory]::Delete($root,$true) }
    }
}
[pscustomobject]@{schema='overdrafter.companion-artifact-test.v1';assertions=$script:assertions;
    passed=$true;network=$false;disk=($PSVersionTable.PSEdition -ceq 'Desktop');nativeActions=0} | ConvertTo-Json
