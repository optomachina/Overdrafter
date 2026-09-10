#requires -Version 5.1
# Pure bounded evidence contract. It never launches processes or grants authority.
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot '../worker-companion/CompanionState.ps1')

# One canonical ASCII JSON representation across Desktop 5.1 and Core. Sorting
# object keys and escaping UTF-16 units avoids serializer/version hash drift.
# Encode one string without changing canonical ASCII JSON or surrogate handling.
function ConvertTo-JournalString([string]$Value) {
    $text=New-Object Text.StringBuilder
    [void]$text.Append('"')
    foreach ($character in $Value.ToCharArray()) {
        $code=[int]$character
        if ($code -eq 34) { [void]$text.Append('\"') }
        elseif ($code -eq 92) { [void]$text.Append('\\') }
        elseif ($code -lt 32 -or $code -gt 126) { [void]$text.Append('\u'+$code.ToString('x4')) }
        else { [void]$text.Append($character) }
    }
    [void]$text.Append('"'); return $text.ToString()
}
function ConvertTo-JournalJson($Value,[int]$Depth=0) {
    if ($Depth -gt 12) { throw 'Journal nesting exceeds its bound.' }
    if ($null -eq $Value) { return 'null' }
    if ($Value -is [bool]) { if ($Value) { return 'true' }; return 'false' }
    if ($Value -is [int] -or $Value -is [long]) { return $Value.ToString([Globalization.CultureInfo]::InvariantCulture) }
    if ($Value -is [string]) { return ConvertTo-JournalString $Value }
    if ($Value -is [array]) {
        $items=@(foreach ($item in $Value) { ConvertTo-JournalJson $item ($Depth+1) })
        return '['+[string]::Join(',',[string[]]$items)+']'
    }
    if ($Value -is [pscustomobject]) {
        [string[]]$keys=@($Value.PSObject.Properties.Name)
        [Array]::Sort($keys,[StringComparer]::Ordinal)
        $items=@(foreach ($key in $keys) { (ConvertTo-JournalJson $key ($Depth+1))+':'+(ConvertTo-JournalJson $Value.$key ($Depth+1)) })
        return '{'+[string]::Join(',',[string[]]$items)+'}'
    }
    throw 'Unsupported journal value type.'
}
function Get-JournalDigest([string]$Text) {
    $hash=[Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($Text))).Replace('-','').ToLowerInvariant() }
    finally { $hash.Dispose() }
}
function Assert-JournalDigest($Value) {
    if ($Value -isnot [string] -or $Value -cnotmatch '^[0-9a-f]{64}\z') { throw 'Invalid journal digest.' }
}
function Assert-JournalId($Value) {
    if ($Value -isnot [string] -or $Value -cnotmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\z' -or
        $Value -ceq '00000000-0000-0000-0000-000000000000') { throw 'Invalid journal identity.' }
}
function Assert-JournalInteger($Value,[long]$Minimum,[long]$Maximum) {
    if (($Value -isnot [int] -and $Value -isnot [long]) -or $Value -lt $Minimum -or $Value -gt $Maximum) { throw 'Invalid journal integer.' }
}
# Lexical Windows path check only. Storage/launcher also inspect filesystem
# identity, local volume and reparse points before actual effects.
function Assert-JournalPath($Value,[switch]$AllowDriveRoot) {
    if ($AllowDriveRoot -and $Value -is [string] -and $Value -cmatch '^[A-Za-z]:\\\z') { return }
    if ($Value -isnot [string] -or $Value.Length -gt 260 -or $Value -cnotmatch '^[A-Za-z]:\\[^\x00-\x1f<>:"/|?*]+\z' -or
        $Value -match '\\\\|\\\.\.?(\\|$)|[. ](\\|$)') { throw 'Invalid journal Windows path.' }
}
function Assert-JournalBinding($Binding) {
    Assert-CompanionKeys $Binding @('organizationId','projectId','workerId','installationId','bootId','taskId','attemptId','jobId','fence','jobSha256','runtimeAdmissionId')
    foreach ($key in @('organizationId','projectId','workerId','installationId','bootId','taskId','attemptId','jobId','runtimeAdmissionId')) { Assert-JournalId $Binding.$key }
    Assert-JournalInteger $Binding.fence 1 9007199254740991L
    Assert-JournalDigest $Binding.jobSha256
}
function New-NativeJournal($Binding) {
    Assert-JournalBinding $Binding
    $copy=ConvertFrom-CompanionJson (ConvertTo-JournalJson $Binding)
    return [pscustomobject]@{schema='overdrafter.native-attempt-journal.v1';binding=$copy;
        records=@();headSha256=(Get-JournalDigest (ConvertTo-JournalJson $copy))}
}
function Get-JournalRecordBody($Record) {
    return [pscustomobject]@{sequence=$Record.sequence;previousSha256=$Record.previousSha256;
        bindingSha256=$Record.bindingSha256;at=$Record.at;kind=$Record.kind;data=$Record.data}
}
function Assert-JournalProcessIdentity($Data) {
    Assert-JournalInteger $Data.pid 1 2147483647
    Assert-JournalInteger $Data.sessionId 0 2147483647
    $ticks=0L
    if ($Data.creationTicks -isnot [string] -or $Data.creationTicks -cnotmatch '^[1-9][0-9]{0,18}\z' -or
        -not [long]::TryParse($Data.creationTicks,[ref]$ticks) -or $ticks -gt [DateTime]::MaxValue.Ticks) { throw 'Invalid process creation time.' }
}
# Validate native/helper ordering before admitting a launch intent.
function Assert-JournalLaunchOrder($State,$Data) {
    $launches=$State.launches
    if ($data.role -cin @('compiler','native')) {
        if ($null -ne $State.nativeId) { throw 'Invalid top-level launch order.' }
        if ($data.role -ceq 'native') {
            foreach ($entry in $launches.Values) {
                if (-not $entry.exited -or $entry.exit.exitCode -ne 0 -or $entry.exit.terminationRequested) { throw 'Compiler exit is unresolved or unsuccessful.' }
            }
            $State.nativeId=$data.launchId
        }
    } else {
        if ($null -eq $State.nativeId -or $null -eq $launches[$State.nativeId].identity -or
            $launches[$State.nativeId].exited) { throw 'Helper lacks its live native target binding.' }
        if ($data.role -ceq 'operation' -and $State.phase -cne 'operation_started') { throw 'Operation phase must precede helper launch.' }
    }
}

# Validate one event before changing only the replay-local state.
function Add-JournalLaunchIntent($State,$Data) {
    $launches=$State.launches
    Assert-CompanionKeys $data @('launchId','role','executablePath','executableSha256','workingDirectory','argumentsSha256','parentLaunchId')
    Assert-JournalId $data.launchId; Assert-JournalPath $data.executablePath; Assert-JournalPath $data.workingDirectory -AllowDriveRoot
    Assert-JournalDigest $data.executableSha256; Assert-JournalDigest $data.argumentsSha256
    if ($launches.ContainsKey($data.launchId) -or $data.role -isnot [string] -or $data.role -cnotin @('compiler','native','lifecycle','operation')) { throw 'Invalid or duplicate launch.' }
    # The prepared runner directly creates every admitted process.
    # The already-running owner is outside this attempt's launch
    # forest. Helpers target SolidWorks but are not its OS children.
    if ($null -ne $data.parentLaunchId) { throw 'Nested process launch is outside this runtime envelope.' }
    foreach ($other in $launches.Values) {
        if ($other.intent.role -cne 'native' -and -not $other.exited) { throw 'Prior helper launch is unresolved.' }
        if ($data.role -ceq 'operation' -and $other.intent.role -ceq 'operation') { throw 'Attempt cannot repeat its native operation.' }
    }
    Assert-JournalLaunchOrder $State $data
    $launches[$data.launchId]=@{intent=$data;identity=$null;exited=$false;exit=$null}
}

# Validate one event before changing only the replay-local state.
function Set-JournalProcessStarted($State,$Data,[DateTimeOffset]$At) {
    $launches=$State.launches
    Assert-CompanionKeys $data @('launchId','pid','creationTicks','sessionId','executablePath','executableSha256')
    Assert-JournalId $data.launchId; Assert-JournalProcessIdentity $data
    Assert-JournalPath $data.executablePath; Assert-JournalDigest $data.executableSha256
    if (-not $launches.ContainsKey($data.launchId) -or $null -ne $launches[$data.launchId].identity) { throw 'Start lacks an unresolved launch intent.' }
    $entry=$launches[$data.launchId]
    # Qualified Windows executable paths may differ only in casing
    # (WINDIR versus the kernel image spelling). Preserve both raw
    # observations; executable content identity remains exact.
    if (-not [string]::Equals($data.executablePath,$entry.intent.executablePath,[StringComparison]::OrdinalIgnoreCase) -or
        $data.executableSha256 -cne $entry.intent.executableSha256 -or
        [long]$data.creationTicks -gt $at.UtcTicks) { throw 'Created process identity differs.' }
    foreach ($other in $launches.Values) {
        if ($null -ne $other.identity -and $other.identity.pid -eq $data.pid -and
            (-not $other.exited -or $other.identity.creationTicks -ceq $data.creationTicks)) { throw 'Process identity was reused.' }
    }
    $entry.identity=$data
}

# Validate one event before changing only the replay-local state.
function Set-JournalProcessExited($State,$Data) {
    $launches=$State.launches
    Assert-CompanionKeys $data @('launchId','pid','creationTicks','sessionId','exitCode','terminationRequested')
    Assert-JournalId $data.launchId; Assert-JournalProcessIdentity $data
    Assert-JournalInteger $data.exitCode -2147483648 2147483647
    if ($data.terminationRequested -isnot [bool] -or -not $launches.ContainsKey($data.launchId)) { throw 'Invalid terminal observation.' }
    $entry=$launches[$data.launchId]
    if ($null -eq $entry.identity -or $entry.exited -or $data.pid -ne $entry.identity.pid -or
        $data.creationTicks -cne $entry.identity.creationTicks -or $data.sessionId -ne $entry.identity.sessionId) { throw 'Exit does not bind an observed creation.' }
    $entry.exited=$true; $entry.exit=$data
}

# Validate one event before changing only the replay-local state.
function Set-JournalPhase($State,$Data) {
    $launches=$State.launches
    Assert-CompanionKeys $data @('phase')
    $next=@{preflight='startup_wait';startup_wait='startup_ready';startup_ready='operation_started';operation_started='operation_completed';operation_completed='outputs_saved'}
    if ($data.phase -isnot [string] -or -not $next.ContainsKey($State.phase) -or $next[$State.phase] -cne $data.phase -or
        $null -eq $State.nativeId -or $null -eq $launches[$State.nativeId].identity -or $launches[$State.nativeId].exited) { throw 'Invalid native phase transition.' }
    if ($data.phase -ceq 'operation_completed') {
        $operations=@($launches.Values | Where-Object { $_.intent.role -ceq 'operation' })
        if ($operations.Count -ne 1 -or -not $operations[0].exited -or $operations[0].exit.exitCode -ne 0 -or
            $operations[0].exit.terminationRequested) { throw 'Operation completion lacks successful helper exit.' }
    }
    $State.phase=$data.phase
}

# Validate one event before changing only the replay-local state.
function Set-JournalFailure($State,$Data) {
    $launches=$State.launches
    Assert-CompanionKeys $data @('code','evidenceSha256')
    Assert-JournalDigest $data.evidenceSha256
    if ($data.code -isnot [string] -or $data.code -cnotin @('native_startup_timeout','input_invalid','runtime_mismatch','native_operation_failed','artifact_invalid','deadline_exceeded','authority_lost','process_uncertain','unclassified')) { throw 'Unknown failure code.' }
    if ($data.code -ceq 'native_startup_timeout' -and $State.phase -cne 'startup_wait') { throw 'Startup timeout is not a post-startup failure.' }
    $State.failure=$data.code
}

# Validate one event before changing only the replay-local state.
function Set-JournalUncertain($State,$Data) {
    $launches=$State.launches
    Assert-CompanionKeys $data @('reason')
    if ($data.reason -isnot [string] -or $data.reason -cnotin @('launch_gap','identity_mismatch','unknown_child','journal_write_failed','exit_unobserved')) { throw 'Unknown uncertainty reason.' }
    $State.uncertain=$true
}

# Check immutable chain identity and monotonic observation time.
function Read-JournalRecordTime($Record,[int]$Sequence,[string]$Previous,[string]$BindingHash,[DateTimeOffset]$LastAt) {
    Assert-CompanionKeys $record @('sequence','previousSha256','bindingSha256','at','kind','data','sha256')
    Assert-JournalInteger $record.sequence 1 2048; Assert-JournalDigest $record.sha256
    Assert-JournalDigest $record.previousSha256; Assert-JournalDigest $record.bindingSha256
    if ($record.sequence -ne $Sequence -or $record.previousSha256 -cne $Previous -or $record.bindingSha256 -cne $BindingHash -or
        $record.sha256 -cne (Get-JournalDigest (ConvertTo-JournalJson (Get-JournalRecordBody $record)))) { throw 'Journal chain differs.' }
    if ($record.at -isnot [string] -or $record.at -cnotmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\z') { throw 'Invalid journal observation time.' }
    Assert-CompanionTimestamp $record.at
    $at=[DateTimeOffset]::Parse($record.at,[Globalization.CultureInfo]::InvariantCulture)
    if ($at -lt $LastAt) { throw 'Journal observation clock moved backwards.' }
    return $at
}

# Failed or uncertain histories admit only their existing terminal observations.
function Update-JournalReplay($State,$Record,[DateTimeOffset]$At) {
    if ($record.kind -isnot [string]) { throw 'Invalid journal event kind.' }
    if ($null -ne $State.failure -and $record.kind -cnotin @('process_exited','uncertain')) { throw 'Failed attempt cannot launch more work.' }
    if ($State.uncertain -and $record.kind -cnotin @('process_exited','uncertain','failure')) { throw 'Uncertain attempt cannot launch more work.' }
    switch -CaseSensitive ($Record.kind) {
        'launch_intent' { Add-JournalLaunchIntent $State $Record.data }
        'process_started' { Set-JournalProcessStarted $State $Record.data $At }
        'process_exited' { Set-JournalProcessExited $State $Record.data }
        'phase' { Set-JournalPhase $State $Record.data }
        'failure' { Set-JournalFailure $State $Record.data }
        'uncertain' { Set-JournalUncertain $State $Record.data }
        default { throw 'Unsupported journal event.' }
    }
}

# Replay state is private to this call; accepted artifacts and inputs are never mutated.
# A complete record set is not physical process-tree or trusted source proof.
function Get-NativeJournalSummary($Journal,[string]$ExpectedHead) {
    Assert-CompanionKeys $Journal @('schema','binding','records','headSha256')
    if ($Journal.schema -isnot [string] -or $Journal.schema -cne 'overdrafter.native-attempt-journal.v1' -or
        $Journal.records -isnot [array] -or $Journal.records.Count -gt 2048) { throw 'Invalid journal envelope.' }
    Assert-JournalBinding $Journal.binding; Assert-JournalDigest $Journal.headSha256
    if ((ConvertTo-JournalJson $Journal).Length -gt 2000000) { throw 'Journal exceeds byte bound.' }
    $bindingHash=Get-JournalDigest (ConvertTo-JournalJson $Journal.binding)
    $previous=$bindingHash; $sequence=0; $lastAt=[DateTimeOffset]::MinValue
    $state=@{launches=@{};nativeId=$null;phase='preflight';failure=$null;uncertain=$false}
    foreach ($record in $Journal.records) {
        $sequence++
        $at=Read-JournalRecordTime $record $sequence $previous $bindingHash $lastAt
        $lastAt=$at; $previous=$record.sha256
        Update-JournalReplay $state $record $at
    }
    if ($Journal.headSha256 -cne $previous -or ($ExpectedHead -and $ExpectedHead -cne $previous)) { throw 'Journal checkpoint differs.' }
    $unresolved=@($state.launches.Values | Where-Object { -not $_.exited }).Count
    return [pscustomobject]@{headSha256=$previous;records=$sequence;launches=$state.launches.Count;unresolvedLaunches=$unresolved;
        recordedProcessesExited=($state.launches.Count -gt 0 -and $unresolved -eq 0 -and -not $State.uncertain);
        recoveryRequired=($unresolved -gt 0 -or $State.uncertain);phase=$State.phase;failureCode=$State.failure;stopAdmission=$false;retryAuthorized=$false}
}
function Add-NativeJournalEvent($Journal,[string]$Kind,$Data,[string]$At) {
    $null=Get-NativeJournalSummary $Journal
    $next=ConvertFrom-CompanionJson (ConvertTo-JournalJson $Journal)
    $body=[pscustomobject]@{sequence=($next.records.Count+1);previousSha256=$next.headSha256;
        bindingSha256=(Get-JournalDigest (ConvertTo-JournalJson $next.binding));at=$At;kind=$Kind;data=(ConvertFrom-CompanionJson (ConvertTo-JournalJson $Data))}
    $digest=Get-JournalDigest (ConvertTo-JournalJson $body)
    $body | Add-Member -NotePropertyName sha256 -NotePropertyValue $digest
    $next.records+=@($body); $next.headSha256=$digest
    $null=Get-NativeJournalSummary $next
    return $next
}
# ExpectedHead comes from an independently retained acknowledgement. Hashes
# alone cannot detect a coherently rehashed history or a valid old prefix.
function Read-NativeJournalText([string]$Text,[string]$ExpectedHead) {
    if ($Text.Length -lt 1 -or $Text.Length -gt 2000000 -or $Text -match '[^\x00-\x7f]') { throw 'Invalid journal wire size or encoding.' }
    $journal=ConvertFrom-CompanionJson $Text
    if ((ConvertTo-JournalJson $journal) -cne $Text) { throw 'Journal wire text is not canonical.' }
    $null=Get-NativeJournalSummary $journal $ExpectedHead
    return $journal
}
