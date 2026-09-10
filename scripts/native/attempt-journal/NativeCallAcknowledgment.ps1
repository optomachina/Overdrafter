#requires -Version 5.1
# Explicit synthetic qualification only; ordinary operation has no observer.
. (Join-Path $PSScriptRoot 'NativeCallEvidence.ps1')

function Write-NativeCallAcknowledgment($Session,$Launch,$Settings,[string]$Directory) {
    Assert-NativeJournalStore $Session.store
    if ($Launch.intent.role -cne 'operation' -or $null -eq $Launch.identity -or
        $Session.store.head -cne $Session.journal.headSha256 -or
        $Session.store.count -ne $Session.journal.records.Count -or
        $Session.journal.records[-1].kind -cne 'process_started' -or
        $Session.journal.records[-1].data.launchId -cne $Launch.intent.launchId) { throw 'Operation creation is not durably acknowledged.' }
    if ($Settings.qualificationBoundary -cnotin @('open_call','part_save_call','assembly_save_call') -or
        $Settings.qualificationSourceCommit -cnotmatch '^[0-9a-f]{40}\z') { throw 'Explicit native qualification settings are required.' }
    Assert-JournalId $Settings.qualificationNonce
    $process=[Diagnostics.Process]::GetCurrentProcess()
    try { $owner=Get-RunnerProcessIdentity $process (Join-Path $PSHOME 'powershell.exe') }
    finally { $process.Dispose() }
    $value=[pscustomobject]@{schema='overdrafter.native-call-acknowledgment.v1';
        boundary=$Settings.qualificationBoundary;sourceCommit=$Settings.qualificationSourceCommit;nonce=$Settings.qualificationNonce;
        owner=$owner;journal=$Session.journal;cipherSha256=(Get-PreparedHash $Session.store.statePath)}
    $temporary=Join-Path $Directory 'native-call-acknowledged.pending'
    [void](Write-PreparedBytes $temporary ([Text.Encoding]::UTF8.GetBytes((ConvertTo-JournalJson $value))))
    [IO.File]::Move($temporary,(Join-Path $Directory 'native-call-acknowledged.json'))
}

function Assert-NativeCallAcknowledgment($Acknowledgment,$Checkpoint,$Binding,$Owner) {
    Assert-CompanionKeys $Acknowledgment @('schema','boundary','sourceCommit','nonce','owner','journal','cipherSha256')
    foreach ($field in @('schema','boundary','sourceCommit','nonce','cipherSha256')) {
        if ($Acknowledgment.$field -isnot [string]) { throw 'Acknowledgment text must be scalar.' }
    }
    Assert-JournalDigest $Acknowledgment.cipherSha256
    if ($Acknowledgment.schema -cne 'overdrafter.native-call-acknowledgment.v1' -or
        $Acknowledgment.boundary -cne $Checkpoint.boundary -or $Acknowledgment.sourceCommit -cne $Checkpoint.sourceCommit -or
        $Acknowledgment.nonce -cne $Checkpoint.nonce -or
        (ConvertTo-JournalJson $Acknowledgment.owner) -cne (ConvertTo-JournalJson $Owner)) { throw 'Native call acknowledgment belongs to another owner or operation.' }
    Assert-NativeCallInterruptedJournal $Acknowledgment.journal $Binding $Checkpoint
}
