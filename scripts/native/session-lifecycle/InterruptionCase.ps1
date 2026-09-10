# Internal extension loaded only by the explicit lifecycle driver. No commands run on load.
# A pinned synthetic part or exact three-file prepared assembly, one retained native interruption, one fresh read-only recovery.

function Get-FixtureIdentity([string]$Path, [long]$Bytes, [string]$Digest) {
    if ([string]::IsNullOrWhiteSpace($Path) -or $Path -notmatch '^[A-Za-z]:\\' -or $Path -match '["\r\n]') {
        throw 'A trusted absolute local fixture path is required.'
    }
    $full = [IO.Path]::GetFullPath($Path)
    $item = Get-Item -LiteralPath $full -ErrorAction Stop
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
        $item.Length -ne $Bytes) { throw 'Synthetic fixture file identity mismatch.' }
    $hash = (Get-FileHash -LiteralPath $full -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($hash -cne $Digest) { throw 'Synthetic fixture digest mismatch.' }
    return [ordered]@{ path = $full; bytes = $item.Length; sha256 = $hash }
}

# CreateNew and an explicit flush preserve checkpoints/results without overwriting history.
function Write-ImmutableRecord([string]$Path, $Value) {
    $bytes = [Text.Encoding]::UTF8.GetBytes(($Value | ConvertTo-Json -Depth 30))
    $stream = New-Object IO.FileStream($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
    try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) }
    finally { $stream.Dispose() }
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Prepare-InterruptionInputs {
    $r.sourcesBefore = @(
        (Get-FixtureIdentity $BaselinePath 56144 'e4ff1efb9ead3efd44ad24262dee670bee7de82a894ea0a0d998a58a3fd8b8aa'),
        (Get-FixtureIdentity $CandidatePath 56171 'b08031412dcdf878680d775d1f9d571c9556d6e9ebf9fce01f83811d36e13898'))
    $names = @('baseline-5mm.SLDPRT')
    $inputs = @($r.sourcesBefore[0])
    $qualification = 'single_synthetic_part_only'
    if ($AssemblyPath) {
        $assembly = Get-FixtureIdentity $AssemblyPath 59987 '90f017c100732cdd24d30ae01e7e64856ba65c8a9c77df4aa2f85ad4f57d9e3a'
        $r.sourcesBefore = @($assembly) + $r.sourcesBefore
        $inputs = $r.sourcesBefore
        $names = @('synthetic-assembly.SLDASM', 'parts\baseline-5mm.SLDPRT', 'parts\candidate-8mm.SLDPRT')
        $qualification = 'prepared_three_file_assembly_only'
    }
    $r.attempts = @()
    foreach ($label in @('interrupted', 'recovery')) {
        $directory = Join-Path $folder $label
        New-Item -ItemType Directory -Path $directory -ErrorAction Stop | Out-Null
        if ($AssemblyPath) { New-Item -ItemType Directory -Path (Join-Path $directory 'parts') -ErrorAction Stop | Out-Null }
        $copies = @()
        for ($index = 0; $index -lt $inputs.Count; $index++) {
            $copy = Join-Path $directory $names[$index]
            [IO.File]::Copy($inputs[$index].path, $copy, $false)
            $copies += Get-FixtureIdentity $copy $inputs[$index].bytes $inputs[$index].sha256
        }
        $fixtureIdentity = $copies[0]
        $manifest = [ordered]@{ id = [Guid]::NewGuid().ToString('N'); role = $label; input = $fixtureIdentity;
            baseline = $inputs; inputs = $copies; qualification = $qualification }
        $manifestHash = Write-ImmutableRecord (Join-Path $directory 'input.json') $manifest
        $r.attempts += [ordered]@{ id = $manifest.id; role = $label; directory = $directory; input = $fixtureIdentity;
            inputs = $copies; inputManifestSha256 = $manifestHash; outcome = 'not_started'; native = $null;
            terminationRequested = $false; exitCode = $null; resultSha256 = $null }
    }
    Save-Receipt
}

# Rehash every private dependency and the immutable input manifest, not just the top file.
function Assert-AttemptInputs($Attempt) {
    $Attempt.inputsAfter = @()
    foreach ($inputFile in $Attempt.inputs) {
        $Attempt.inputsAfter += Get-FixtureIdentity $inputFile.path $inputFile.bytes $inputFile.sha256
    }
    $Attempt.inputAfter = $Attempt.inputsAfter[0]
    if ((Get-FileHash -LiteralPath (Join-Path $Attempt.directory 'input.json') -Algorithm SHA256).Hash.ToLowerInvariant() -cne
        $Attempt.inputManifestSha256) { throw 'Attempt input manifest changed.' }
}

function Assert-OriginalFixtures {
    $r.sourcesAfter = @()
    foreach ($source in $r.sourcesBefore) {
        $r.sourcesAfter += Get-FixtureIdentity $source.path $source.bytes $source.sha256
    }
    Save-Receipt
}

# Each helper returns before interruption. API/file identity is rechecked by the compiled probe.
function Invoke-FixtureProbe([string]$Mode, $Attempt, [string]$Label) {
    Assert-Identity $native $Attempt.native
    if ((Get-FileHash -LiteralPath $helper -Algorithm SHA256).Hash.ToLowerInvariant() -ne $r.binarySha256) {
        throw 'probe binary drift'
    }
    Assert-AttemptInputs $Attempt
    $r.stage = $Label; Save-Receipt
    if ($AssemblyPath) { $Mode = $Mode.Replace('fixture-', 'assembly-') }
    $arguments = @($Mode, [string]$Attempt.native.pid, $Attempt.native.ticks,
        [string]$Attempt.native.session, $Attempt.input.path)
    $obs = Invoke-OwnedProcess $helper $arguments 30000 (Join-Path $folder $Label)
    $r.observations += $obs; Save-Receipt
    if ($obs.timedOut -or $obs.error -or $obs.exitCode -ne 0) { throw ('Fixture helper failed: ' + $Label) }
    $data = $obs.stdout | ConvertFrom-Json
    $count = 1
    if ($AssemblyPath) { $count = 3 }
    if ($Mode -eq 'fixture-close' -or $Mode -eq 'assembly-close') { $count = 0 }
    if ($data.outcome -ne 'passed' -or $data.apiPid -ne $Attempt.native.pid -or
        $data.expectedTicks -cne $Attempt.native.ticks -or $data.startupCompleted -ne $true -or
        $data.exitAppRequested -ne $false -or $data.documentCount -ne $count -or
        $data.fixture.verified -ne $true -or $data.fixture.readOnly -ne $true -or
        $data.fixture.documentCountAfter -ne $count -or $data.fixture.path -ine $Attempt.input.path) {
        throw 'Fixture helper evidence mismatch.'
    }
    return $data
}

function Start-FixtureAttempt($Attempt) {
    $Attempt.outcome = 'running'; Save-Receipt
    Start-NativeProcess ('start_' + $Attempt.role)
    $Attempt.native = $r.native; Save-Receipt
    if (-not $native.WaitForInputIdle(60000)) { throw 'native readiness unconfirmed' }
    Wait-NativeReady ($Attempt.role + '-ready')
    $Attempt.openObservation = Invoke-FixtureProbe 'fixture-open' $Attempt ($Attempt.role + '-open')
    Save-Receipt
}

# Kill is deliberately local to this admitted case. Never look a target up by PID or name.
# The retained object came directly from Start-NativeProcess, and helpers have already exited.
function Interrupt-FixtureAttempt($Attempt) {
    if (-not $InterruptReadonly -or $ExpectedOldPid -ne 0 -or -not $r.nativeStarted -or
        $Attempt.role -ne 'interrupted' -or $Attempt.terminationRequested) { throw 'Interruption not admitted.' }
    $observed = Invoke-FixtureProbe 'fixture-inspect' $Attempt 'before-interrupt'
    $checkpoint = [ordered]@{ utc = [DateTime]::UtcNow.ToString('o'); attempt = $Attempt.id;
        native = $Attempt.native; inputManifestSha256 = $Attempt.inputManifestSha256;
        binarySha256 = $r.binarySha256; sourceHashes = $r.sourceHashes; observation = $observed;
        action = 'interrupt_retained_native_process'; interruptedSaveRecovery = $false }
    $Attempt.checkpointSha256 = Write-ImmutableRecord (Join-Path $Attempt.directory 'pre-interrupt.json') $checkpoint
    Assert-Identity $native $Attempt.native
    $Attempt.terminationRequested = $true; $r.stage = 'interrupt_native'; Save-Receipt
    $native.Kill()
    if (-not $native.WaitForExit(30000)) { throw 'Interrupted native exit unconfirmed.' }
    $Attempt.exitCode = $native.ExitCode
    if ($Attempt.exitCode -eq 0) { throw 'Native exited normally; interruption not established.' }
    Assert-NoNative 'Native process remains after interruption.'
    Assert-AttemptInputs $Attempt
    Assert-OriginalFixtures
    $Attempt.outcome = 'interrupted'
    $Attempt.resultSha256 = Write-ImmutableRecord (Join-Path $Attempt.directory 'attempt-result.json') $Attempt
    Save-Receipt
    $native.Dispose(); $script:native = $null; $r.nativeStarted = $false
}

function Invoke-InterruptionCase {
    $active = $r.attempts[0]
    try {
        Start-FixtureAttempt $active
        Interrupt-FixtureAttempt $active
        $active = $r.attempts[1]
        Start-FixtureAttempt $active
        $active.closeObservation = Invoke-FixtureProbe 'fixture-close' $active 'recovery-close-fixture'
        Close-OwnedNative 'recovery-close-native'
        $active.exitCode = $r.nativeExit
        Assert-AttemptInputs $active
        Assert-OriginalFixtures
        $active.outcome = 'verified_readonly_recovery'
        $active.resultSha256 = Write-ImmutableRecord (Join-Path $active.directory 'attempt-result.json') $active
        $r.interruptionRecovery = 'passed_single_readonly_fixture'
        if ($AssemblyPath) { $r.interruptionRecovery = 'passed_readonly_assembly_closure' }
        Save-Receipt
    } catch {
        if ($active.outcome -eq 'running') { $active.outcome = 'failed' }
        $active.error = $_.Exception.Message
        if ($native) {
            try { $active.nativeHasExited = $native.HasExited; if ($active.nativeHasExited) { $active.exitCode = $native.ExitCode } }
            catch { $active.observationError = $_.Exception.Message }
        }
        throw
    }
}
