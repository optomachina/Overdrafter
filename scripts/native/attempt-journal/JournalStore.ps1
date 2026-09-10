#requires -Version 5.1
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'JournalContract.ps1')
. (Join-Path $PSScriptRoot '../worker-companion/CompanionStore.ps1')

# One protected directory/lock per immutable attempt. Existing missing or
# malformed state is never repaired or interpreted as a new launch permission.
function Open-NativeJournalStore($Binding,[bool]$AllowCreate) {
    Assert-CompanionWindows; Assert-JournalBinding $Binding
    $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
    try { $sid=$identity.User } finally { $identity.Dispose() }
    $local=[Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
    $workerRoot=Join-Path $local ('OverDrafter\NativeAttempts\'+$Binding.workerId)
    $root=Assert-CompanionLocalPath (Join-Path $workerRoot ('Attempts\'+$Binding.attemptId))
    $new=-not [IO.Directory]::Exists($root)
    if ($new -and -not $AllowCreate) { throw 'Attempt journal is missing; recovery is required.' }
    foreach ($path in @((Join-Path $local 'OverDrafter'),(Join-Path $local 'OverDrafter\NativeAttempts'),$workerRoot,(Join-Path $workerRoot 'Attempts'),$root)) {
        $null=Assert-CompanionLocalPath $path
        if (-not [IO.Directory]::Exists($path)) {
            if (-not $AllowCreate) { throw 'Journal parent is missing.' }
            $directory=New-Object IO.DirectoryInfo($path); $directory.Create((New-CompanionAcl $sid $true))
        }
        Assert-CompanionPrivateAcl $path $sid $true
    }
    $lockPath=Join-Path $root 'owner.lock'; $lock=$null
    try {
        if ([IO.File]::Exists($lockPath)) {
            Assert-CompanionPrivateAcl $lockPath $sid $false
            $lock=New-Object IO.FileStream($lockPath,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
        } else { $lock=New-CompanionPrivateFile $lockPath $sid }
        $statePath=Join-Path $root 'journal.dpapi'
        if ([IO.File]::Exists($statePath) -eq $new) { throw 'Journal creation state differs; preserve it for recovery.' }
        $store=[pscustomobject]@{root=$root;statePath=$statePath;lock=$lock;sid=$sid;isNew=$new;poisoned=$false;
            binding=(ConvertFrom-CompanionJson (ConvertTo-JournalJson $Binding));head=$null;count=0}
        if (-not $new) {
            $journal=Read-NativeJournalStore $store
            $store.head=$journal.headSha256; $store.count=$journal.records.Count
        }
        return $store
    } catch { if ($null -ne $lock) { $lock.Dispose() }; throw }
}
function Assert-NativeJournalStore($Store) {
    Assert-CompanionWindows
    if ($Store.poisoned -or $null -eq $Store.lock -or -not $Store.lock.CanWrite) { throw 'Journal write ownership is unavailable.' }
    Assert-CompanionPrivateAcl $Store.root $Store.sid $true
    Assert-JournalBinding $Store.binding
}
function Read-NativeJournalStore($Store) {
    Assert-NativeJournalStore $Store
    Assert-CompanionPrivateAcl $Store.statePath $Store.sid $false
    # Bound the opened file, not a prior pathname observation, before allocation.
    $stream=New-Object IO.FileStream($Store.statePath,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    try {
        if ($stream.Length -lt 1 -or $stream.Length -gt 2010000) { throw 'Invalid journal ciphertext size.' }
        $cipher=New-Object byte[] ([int]$stream.Length); $offset=0
        while ($offset -lt $cipher.Length) {
            $read=$stream.Read($cipher,$offset,$cipher.Length-$offset)
            if ($read -eq 0) { throw 'Journal ciphertext was truncated.' }
            $offset+=$read
        }
        if ($stream.ReadByte() -ne -1) { throw 'Journal ciphertext changed length.' }
    } finally { $stream.Dispose() }
    $plain=$null
    $entropy=[Text.Encoding]::UTF8.GetBytes('overdrafter.native-attempt-journal.v1:'+$Store.binding.workerId+':'+$Store.binding.attemptId)
    try {
        $plain=[Security.Cryptography.ProtectedData]::Unprotect($cipher,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
        if ($plain.Length -gt 2000000) { throw 'Journal plaintext exceeds its bound.' }
        $encoding=New-Object Text.UTF8Encoding($false,$true)
        $journal=Read-NativeJournalText ($encoding.GetString($plain))
        if ((ConvertTo-JournalJson $journal.binding) -cne (ConvertTo-JournalJson $Store.binding)) { throw 'Stored attempt binding differs.' }
        return $journal
    } finally { if ($null -ne $plain) { [Array]::Clear($plain,0,$plain.Length) } }
}
# On any uncertain save, poison this handle before allowing another effect. A
# restart may inspect retained bytes; it cannot infer whether a launch occurred.
function Save-NativeJournalStore($Store,$Journal) {
    Assert-NativeJournalStore $Store
    $null=Get-NativeJournalSummary $Journal
    if ((ConvertTo-JournalJson $Journal.binding) -cne (ConvertTo-JournalJson $Store.binding)) { throw 'Journal binding cannot change.' }
    if ($Store.isNew) {
        if ($Journal.records.Count -ne 0 -or $null -ne $Store.head) { throw 'New journal must start with an empty acknowledged history.' }
    } else {
        $current=Read-NativeJournalStore $Store
        if ($current.headSha256 -cne $Store.head -or $current.records.Count -ne $Store.count -or
            $Journal.records.Count -ne $Store.count+1 -or $Journal.records[-1].previousSha256 -cne $Store.head) { throw 'Journal append checkpoint differs.' }
    }
    $plain=[Text.Encoding]::UTF8.GetBytes((ConvertTo-JournalJson $Journal))
    $entropy=[Text.Encoding]::UTF8.GetBytes('overdrafter.native-attempt-journal.v1:'+$Store.binding.workerId+':'+$Store.binding.attemptId)
    try {
        $cipher=[Security.Cryptography.ProtectedData]::Protect($plain,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
    } finally { [Array]::Clear($plain,0,$plain.Length) }
    if ($cipher.Length -gt 2010000) { throw 'Journal ciphertext exceeds its bound.' }
    $temporary=Join-Path $Store.root ([Guid]::NewGuid().ToString()+'.pending.dpapi')
    try {
        $stream=New-CompanionPrivateFile $temporary $Store.sid
        try { $stream.Write($cipher,0,$cipher.Length); $stream.Flush($true) } finally { $stream.Dispose() }
        Assert-CompanionPrivateAcl $temporary $Store.sid $false
        if ($Store.isNew) { [IO.File]::Move($temporary,$Store.statePath) }
        else {
            Assert-CompanionPrivateAcl $Store.statePath $Store.sid $false
            [IO.File]::Replace($temporary,$Store.statePath,[NullString]::Value)
        }
        $readback=Read-NativeJournalStore $Store
        if ((ConvertTo-JournalJson $readback) -cne (ConvertTo-JournalJson $Journal)) { throw 'Journal readback differs.' }
        $Store.head=$Journal.headSha256; $Store.count=$Journal.records.Count; $Store.isNew=$false
    } catch { $Store.poisoned=$true; throw }
}
