# Internal extension loaded only by the explicit lifecycle driver. No commands run on load.
# One pinned synthetic file, one retained native interruption, one fresh read-only recovery.

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
    $r.attempts = @()
    foreach ($label in @('interrupted', 'recovery')) {
        $directory = Join-Path $folder $label
        New-Item -ItemType Directory -Path $directory -ErrorAction Stop | Out-Null
        $copy = Join-Path $directory 'baseline-5mm.SLDPRT'
        [IO.File]::Copy($r.sourcesBefore[0].path, $copy, $false)
        $fixtureIdentity = Get-FixtureIdentity $copy 56144 $r.sourcesBefore[0].sha256
        $manifest = [ordered]@{ id = [Guid]::NewGuid().ToString('N'); role = $label; input = $fixtureIdentity;
            baseline = $r.sourcesBefore[0]; qualification = 'single_synthetic_part_only' }
        $manifestHash = Write-ImmutableRecord (Join-Path $directory 'input.json') $manifest
        $r.attempts += [ordered]@{ id = $manifest.id; role = $label; directory = $directory; input = $fixtureIdentity;
            inputManifestSha256 = $manifestHash; outcome = 'not_started'; native = $null;
            terminationRequested = $false; exitCode = $null; resultSha256 = $null }
    }
    Save-Receipt
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
    $r.stage = $Label; Save-Receipt
    $arguments = @($Mode, [string]$Attempt.native.pid, $Attempt.native.ticks,
        [string]$Attempt.native.session, $Attempt.input.path)
    $obs = Invoke-OwnedProcess $helper $arguments 30000 (Join-Path $folder $Label)
    $r.observations += $obs; Save-Receipt
    if ($obs.timedOut -or $obs.error -or $obs.exitCode -ne 0) { throw ('Fixture helper failed: ' + $Label) }
    $data = $obs.stdout | ConvertFrom-Json
    $count = 1
    if ($Mode -eq 'fixture-close') { $count = 0 }
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
    $Attempt.inputAfter = Get-FixtureIdentity $Attempt.input.path $Attempt.input.bytes $Attempt.input.sha256
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
        $active.inputAfter = Get-FixtureIdentity $active.input.path $active.input.bytes $active.input.sha256
        Assert-OriginalFixtures
        $active.outcome = 'verified_readonly_recovery'
        $active.resultSha256 = Write-ImmutableRecord (Join-Path $active.directory 'attempt-result.json') $active
        $r.interruptionRecovery = 'passed_single_readonly_fixture'; Save-Receipt
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
