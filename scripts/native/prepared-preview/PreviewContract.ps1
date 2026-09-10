# Pure local admission helpers. The caller first loads the shared WireContract.ps1.
$PreviewStepLimit = 2000000
$PreviewJsonLimit = 3000000

function Assert-PreviewDigest($Value) {
    if ($Value -isnot [string] -or $Value -cnotmatch '^[0-9a-f]{64}$') { throw 'Expected a lowercase SHA-256 digest.' }
}

function Assert-PreviewOutputFiles($Files) {
    if ($Files -isnot [array] -or $Files.Count -ne 3) { throw 'Preview requires exactly three native files.' }
    $names = @()
    foreach ($file in $Files) {
        Assert-PreparedKeys $file @('path', 'bytes', 'sha256')
        if ($file.path -isnot [string] -or @($PreparedFiles.path) -cnotcontains $file.path -or $names -ccontains $file.path) {
            throw 'Unsupported or duplicate native output path.'
        }
        if (-not (Test-PreparedNumber $file.bytes) -or $file.bytes -le 0 -or $file.bytes -gt 9007199254740991 -or
            [Math]::Truncate($file.bytes) -ne $file.bytes) { throw 'Native byte count must be a positive safe integer.' }
        Assert-PreviewDigest $file.sha256
        $names += $file.path
    }
}

function Assert-PreviewIdentities($Actual, $Expected) {
    if (@($Actual).Count -ne 3 -or @($Expected).Count -ne 3) { throw 'Incomplete native package identity.' }
    foreach ($file in $Expected) {
        $matches = @($Actual | Where-Object { $_.path -ceq $file.path })
        if ($matches.Count -ne 1 -or $matches[0].bytes -ne $file.bytes -or $matches[0].sha256 -cne $file.sha256) {
            throw ('Native file identity differs: ' + $file.path)
        }
    }
}

function Assert-PreviewResult($Receipt, $Request, [string]$ContextHash) {
    $value = $Receipt.value; $job = $Request.value
    Assert-PreparedKeys $value @('schema', 'jobId', 'attemptId', 'requestSha256', 'contextSha256', 'depthMm',
        'outcome', 'failureReason', 'inputFiles', 'outputFiles', 'checks', 'measurements', 'candidateRoot', 'completedAt', 'adoption')
    foreach ($pair in @(@($value.schema, 'overdrafter.prepared-dimension-result.v1'), @($value.jobId, $job.jobId),
        @($value.attemptId, $job.attemptId), @($value.requestSha256, $Request.sha256), @($value.contextSha256, $ContextHash),
        @($value.outcome, 'succeeded'), @($value.adoption, 'unadopted'))) {
        if (-not (Test-PreparedText $pair[0] $pair[1])) { throw 'Successful candidate result binding mismatch.' }
    }
    if ($null -ne $value.failureReason -or -not (Test-PreparedNumber $value.depthMm) -or $value.depthMm -ne $job.depthMm) {
        throw 'Candidate result is not the requested success.'
    }
    Assert-PreparedTime $value.completedAt
    if ([string]::CompareOrdinal($value.completedAt, $job.createdAt) -lt 0) { throw 'Candidate result predates its request.' }
    Assert-PreparedFiles $value.inputFiles; Assert-PreviewOutputFiles $value.outputFiles
    if ($value.checks -isnot [array] -or $value.checks.Count -ne 7) { throw 'Candidate requires all seven checks.' }
    $seen = @()
    foreach ($check in $value.checks) {
        Assert-PreparedKeys $check @('id', 'verdict', 'evidenceSha256')
        if ($check.id -isnot [string] -or $PreparedChecks -cnotcontains $check.id -or $seen -ccontains $check.id -or
            -not (Test-PreparedText $check.verdict 'pass')) { throw 'Candidate check set did not pass.' }
        Assert-PreviewDigest $check.evidenceSha256; $seen += $check.id
    }
    Assert-PreparedKeys $value.measurements @('beforeDepthMm', 'afterDepthMm', 'beforeVolumeMm3', 'afterVolumeMm3')
    Assert-PreparedMeasurements $value $job
    $target = @($value.outputFiles | Where-Object { $_.path -ceq $PreparedFiles[1].path })[0]
    $companion = @($value.outputFiles | Where-Object { $_.path -ceq $PreparedFiles[2].path })[0]
    if ($target.sha256 -ceq $PreparedFiles[1].sha256 -or $companion.sha256 -cne $PreparedFiles[2].sha256 -or
        $companion.bytes -ne $PreparedFiles[2].bytes) { throw 'Candidate target or companion identity is invalid.' }
}

# Return only explicitly named existing function definitions. Never execute the dimension
# driver's top-level statements or its editing operation. These are trusted repo sources.
function Get-PreviewRuntimeFunctions([string]$Path) {
    $tokens = $null; $errors = $null
    $ast = [Management.Automation.Language.Parser]::ParseFile($Path, [ref]$tokens, [ref]$errors)
    if ($errors.Count -ne 0) { throw 'Shared driver cannot be parsed.' }
    $names = @('Save-PreparedProgress', 'Fail-PreparedAttempt', 'Throw-PreparedFailure', 'Invoke-PreparedChild', 'Assert-PreparedNativeAbsent', 'Assert-PreparedRuntime',
        'Assert-PreparedNativeIdentity', 'Invoke-PreparedLifecycle', 'New-PreparedStartupClock', 'Wait-PreparedNativeReady', 'Assert-PreparedMeasurements')
    $definitions = $ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] }, $false)
    $text = @()
    foreach ($name in $names) {
        $matches = @($definitions | Where-Object { $_.Name -ceq $name -and $_.Parent -is [Management.Automation.Language.NamedBlockAst] })
        if ($matches.Count -ne 1) { throw ('Shared function is missing or ambiguous: ' + $name) }
        $text += $matches[0].Extent.Text
    }
    return [scriptblock]::Create(($text -join "`n"))
}

function Read-PreviewBinding([string]$Role, [string]$ContextPath, [string]$RequestPath, [string]$ResultPath, [string]$SourceRoot) {
    $context = Read-PreparedJson $ContextPath
    if (Test-PreparedText $context.value.schema 'overdrafter.prepared-assembly.v2') {
        return Read-CumulativePreviewBinding $Role $context $RequestPath $ResultPath
    }
    Assert-PreparedContext $context.value
    $binding = @{ context = $context; role = $Role; request = $null; receipt = $null; requestSha256 = $null;
        resultSha256 = $null; nativeFiles = $context.value.files; depthMm = 5 }
    if ($Role -ceq 'baseline') {
        if ($RequestPath -or $ResultPath) { throw 'Baseline preview has no request or result.' }
    } elseif ($Role -ceq 'candidate') {
        if (-not $RequestPath -or -not $ResultPath) { throw 'Candidate preview requires exact request and result files.' }
        $request = Read-PreparedJson $RequestPath; Assert-PreparedJob $request.value
        if ($request.value.contextSha256 -cne $context.sha256) { throw 'Request does not bind these context bytes.' }
        $receipt = Read-PreparedJson $ResultPath; Assert-PreviewResult $receipt $request $context.sha256
        if ($receipt.value.candidateRoot -isnot [string] -or
            -not (Resolve-PreparedLocalPath $receipt.value.candidateRoot).Equals($SourceRoot, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'SourceRoot is not the successful result candidateRoot.'
        }
        $binding.request = $request; $binding.receipt = $receipt
        $binding.requestSha256 = $request.sha256; $binding.resultSha256 = $receipt.sha256
        $binding.nativeFiles = $receipt.value.outputFiles; $binding.depthMm = $request.value.depthMm
    } else { throw 'Role must be exactly baseline or candidate.' }
    return $binding
}

# A v2 preview consumes the exact realized snapshot, not the prior input context
# plus an unbound requested depth. Declared checks remain imported claims; the
# native exporter independently measures the private snapshot's actual geometry.
function Read-CumulativePreviewBinding([string]$Role, $Context, [string]$RequestPath, [string]$ResultPath) {
    Assert-CumulativeContext $Context.value
    if ($RequestPath -or $ResultPath) { throw 'A cumulative preview uses only its exact snapshot context, without separate request/result files.' }
    $expectedRole = 'baseline'; $requestHash = $null; $resultHash = $null
    if ($Context.value.sequence -gt 0) {
        $expectedRole = 'candidate'
        $requestHash = $Context.value.producer.requestSha256; $resultHash = $Context.value.producer.resultSha256
    }
    if ($Role -cne $expectedRole) { throw 'Preview role differs from the cumulative snapshot.' }
    return @{ context = $Context; role = $Role; request = $null; receipt = $null;
        requestSha256 = $requestHash; resultSha256 = $resultHash;
        nativeFiles = $Context.value.files; depthMm = $Context.value.depthMm }
}

# Pure bundle construction: the supervisor must first confirm normal exit and source preservation.
function New-PreviewBundle($Binding, [byte[]]$StepBytes, [string]$ReportHash, $SourceCommit) {
    if ($null -ne $SourceCommit -and ($SourceCommit -isnot [string] -or $SourceCommit -cnotmatch '^[0-9a-f]{40}$')) {
        throw 'SourceCommit must be null or a lowercase commit label.'
    }
    if ($StepBytes.Length -eq 0 -or $StepBytes.Length -gt $PreviewStepLimit) { throw 'STEP exceeds the 2,000,000-byte bound.' }
    $text = [Text.Encoding]::ASCII.GetString($StepBytes).Trim()
    if (-not $text.StartsWith('ISO-10303-21;', [StringComparison]::Ordinal) -or
        -not $text.EndsWith('END-ISO-10303-21;', [StringComparison]::Ordinal)) { throw 'STEP exchange envelope is missing.' }
    Assert-PreviewDigest $ReportHash
    $bundle = [ordered]@{
        schema = 'overdrafter.prepared-step-preview.v1'; contextSha256 = $Binding.context.sha256; role = $Binding.role;
        requestSha256 = $Binding.requestSha256; resultSha256 = $Binding.resultSha256; configuration = 'Default';
        nativeFiles = $Binding.nativeFiles;
        step = [ordered]@{ fileName = 'assembly.step'; bytes = $StepBytes.Length;
            sha256 = (Get-PreparedBytesHash $StepBytes); base64 = [Convert]::ToBase64String($StepBytes) };
        export = [ordered]@{ nativeVersion = '30.5.0'; reportSha256 = $ReportHash; sourceCommit = $SourceCommit };
        limitations = @('Imported operator evidence; hashes bind bytes and do not authenticate the operator.',
            'Whole native assembly exported from verified private read-only references; STEP geometry is not independently reimported by this runner.',
            'Shared existing Windows profile; this experiment does not qualify a filesystem or network sandbox.',
            'Preview only; no native adoption, PDM writes, publication, or manufacturing release.')
    }
    if (Test-PreparedText $Binding.context.value.schema 'overdrafter.prepared-assembly.v2') {
        $bundle.schema = 'overdrafter.prepared-step-preview.v2'
        $bundle.scope = $Binding.context.value.scope
        $bundle.snapshotId = $Binding.context.value.snapshotId
    }
    $encoding = New-Object Text.UTF8Encoding($false, $true)
    [byte[]]$bytes = $encoding.GetBytes(($bundle | ConvertTo-Json -Depth 40) + "`n")
    if ($bytes.Length -gt $PreviewJsonLimit) { throw 'Preview JSON exceeds the 3,000,000-byte bound.' }
    return ,$bytes
}
