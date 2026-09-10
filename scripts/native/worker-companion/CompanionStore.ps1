#requires -Version 5.1
# Windows-only CurrentUser DPAPI storage. The caller holds one exclusive handle
# for the whole companion process; uncertain encrypted files are never deleted.
Set-StrictMode -Version Latest
function Assert-CompanionWindows {
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or
        $PSVersionTable.PSEdition -cne 'Desktop' -or $PSVersionTable.PSVersion.Major -ne 5 -or
        $PSVersionTable.PSVersion.Minor -ne 1 -or -not [Environment]::Is64BitProcess) {
        throw 'Companion requires admitted 64-bit Windows PowerShell 5.1.'
    }
    Add-Type -AssemblyName System.Security
}
function Assert-CompanionLocalPath([string]$Path) {
    $full=[IO.Path]::GetFullPath($Path)
    if ($full -cnotmatch '^[A-Za-z]:\\' -or $full.StartsWith('\\')) { throw 'Companion state requires a local Windows volume.' }
    $cursor=$full
    while ($cursor) {
        try {
            $attributes=[IO.File]::GetAttributes($cursor)
        } catch [IO.FileNotFoundException] {
            # A genuinely absent path is allowed only for later CreateNew calls.
            $attributes=$null
        } catch [IO.DirectoryNotFoundException] {
            # All existing ancestors are still inspected below.
            $attributes=$null
        }
        if ($null -ne $attributes -and ($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Companion state path contains a reparse point.' }
        $parent=[IO.Path]::GetDirectoryName($cursor)
        if ($parent -ceq $cursor) { break }; $cursor=$parent
    }
    return $full
}
function New-CompanionAcl($Sid,[bool]$Directory) {
    if ($Directory) { $acl=New-Object Security.AccessControl.DirectorySecurity }
    else { $acl=New-Object Security.AccessControl.FileSecurity }
    $acl.SetOwner($Sid); $acl.SetAccessRuleProtection($true,$false)
    $inherit=[Security.AccessControl.InheritanceFlags]::None
    if ($Directory) { $inherit=[Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit }
    $rule=New-Object Security.AccessControl.FileSystemAccessRule($Sid,[Security.AccessControl.FileSystemRights]::FullControl,
        $inherit,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)
    $acl.AddAccessRule($rule)
    return $acl
}
function Assert-CompanionPrivateAcl([string]$Path,$Sid,[bool]$Directory) {
    $null=Assert-CompanionLocalPath $Path
    if ($Directory) { $info=New-Object IO.DirectoryInfo($Path) } else { $info=New-Object IO.FileInfo($Path) }
    if (-not $info.Exists) { throw 'Companion state object is missing.' }
    $acl=$info.GetAccessControl()
    if (-not $acl.AreAccessRulesProtected -or $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne $Sid.Value) {
        throw 'Companion state ownership or inheritance differs.'
    }
    $rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
    if ($rules.Count -ne 1 -or $rules[0].IdentityReference.Value -cne $Sid.Value -or
        $rules[0].AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
        $rules[0].FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl) { throw 'Companion state permissions differ.' }
}
function New-CompanionPrivateFile([string]$Path,$Sid) {
    $null=Assert-CompanionLocalPath $Path
    return New-Object IO.FileStream($Path,[IO.FileMode]::CreateNew,[Security.AccessControl.FileSystemRights]::FullControl,
        [IO.FileShare]::None,4096,[IO.FileOptions]::WriteThrough,(New-CompanionAcl $Sid $false))
}
# Only the dedicated per-user worker directory is admitted. Existing malformed
# directories are not repaired automatically, and existing missing state is not
# interpreted as permission to generate a replacement credential.
function Open-CompanionStore([string]$WorkerId,[bool]$AllowCreate) {
    Assert-CompanionWindows; Assert-CompanionId $WorkerId
    $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
    try { $sid=$identity.User } finally { $identity.Dispose() }
    $local=[Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
    $root=Assert-CompanionLocalPath (Join-Path $local ('OverDrafter\Worker\'+$WorkerId))
    $new=-not [IO.Directory]::Exists($root)
    if ($new -and -not $AllowCreate) { throw 'Initial companion pairing code is required.' }
    foreach ($directory in @((Join-Path $local 'OverDrafter'),(Join-Path $local 'OverDrafter\Worker'),$root)) {
        $null=Assert-CompanionLocalPath $directory
        if (-not [IO.Directory]::Exists($directory)) {
            $info=New-Object IO.DirectoryInfo($directory); $info.Create((New-CompanionAcl $sid $true))
        }
        Assert-CompanionPrivateAcl $directory $sid $true
    }
    $lockPath=Join-Path $root 'owner.lock'; $lock=$null
    try {
        if ([IO.File]::Exists($lockPath)) {
            Assert-CompanionPrivateAcl $lockPath $sid $false
            $lock=New-Object IO.FileStream($lockPath,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
        } else { $lock=New-CompanionPrivateFile $lockPath $sid }
        $statePath=Join-Path $root 'state.dpapi'
        $null=Assert-CompanionLocalPath $statePath
        if (-not $new -and -not [IO.File]::Exists($statePath)) { throw 'Existing companion state is missing; reconciliation is required.' }
        if ($new -and [IO.File]::Exists($statePath)) { throw 'Companion initialization raced another process.' }
        return [pscustomobject]@{root=$root;statePath=$statePath;lock=$lock;sid=$sid;workerId=$WorkerId;isNew=$new}
    } catch { if ($null -ne $lock) { $lock.Dispose() }; throw }
}
function Assert-CompanionStoreHandle($Store) {
    Assert-CompanionWindows
    if ($null -eq $Store.lock -or -not $Store.lock.CanWrite) { throw 'Companion store is not exclusively owned.' }
    Assert-CompanionPrivateAcl $Store.root $Store.sid $true
}
function Read-CompanionStore($Store) {
    Assert-CompanionStoreHandle $Store
    Assert-CompanionPrivateAcl $Store.statePath $Store.sid $false
    $file=New-Object IO.FileInfo($Store.statePath)
    if ($file.Length -lt 1 -or $file.Length -gt 32768) { throw 'Companion ciphertext size is invalid.' }
    $cipher=[IO.File]::ReadAllBytes($Store.statePath); $plain=$null
    $entropy=[Text.Encoding]::UTF8.GetBytes('overdrafter.worker-companion.v1:'+ $Store.workerId)
    try {
        $plain=[Security.Cryptography.ProtectedData]::Unprotect($cipher,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
        if ($plain.Length -gt 16384) { throw 'Companion plaintext size is invalid.' }
        $encoding=New-Object Text.UTF8Encoding($false,$true)
        $state=ConvertFrom-CompanionJson ($encoding.GetString($plain)); Assert-CompanionState $state
        if ($state.workerId -cne $Store.workerId) { throw 'Companion credential belongs to a different worker.' }
        return $state
    } finally { if ($null -ne $plain) { [Array]::Clear($plain,0,$plain.Length) } }
}
function Save-CompanionStore($Store,$State) {
    Assert-CompanionStoreHandle $Store; Assert-CompanionState $State
    if ($State.workerId -cne $Store.workerId) { throw 'Companion state worker differs.' }
    $encoding=New-Object Text.UTF8Encoding($false,$true)
    $plain=$encoding.GetBytes(($State | ConvertTo-Json -Depth 20 -Compress))
    $entropy=[Text.Encoding]::UTF8.GetBytes('overdrafter.worker-companion.v1:'+ $Store.workerId)
    try {
        if ($plain.Length -gt 16384) { throw 'Companion state is too large.' }
        $cipher=[Security.Cryptography.ProtectedData]::Protect($plain,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
    } finally { [Array]::Clear($plain,0,$plain.Length) }
    if ($cipher.Length -gt 32768) { throw 'Companion ciphertext is too large.' }
    $temporary=Join-Path $Store.root ([Guid]::NewGuid().ToString()+'.pending.dpapi')
    $stream=New-CompanionPrivateFile $temporary $Store.sid
    try { $stream.Write($cipher,0,$cipher.Length); $stream.Flush($true) } finally { $stream.Dispose() }
    Assert-CompanionPrivateAcl $temporary $Store.sid $false
    if ([IO.File]::Exists($Store.statePath)) {
        Assert-CompanionPrivateAcl $Store.statePath $Store.sid $false
        # PowerShell coerces $null to an empty string for this .NET parameter.
        # NullString passes the actual null that means no backup path.
        [IO.File]::Replace($temporary,$Store.statePath,[NullString]::Value)
    } else {
        if (-not $Store.isNew) { throw 'Companion state disappeared during update.' }
        [IO.File]::Move($temporary,$Store.statePath)
    }
    $Store.isNew=$false
    $readback=Read-CompanionStore $Store
    if (($readback | ConvertTo-Json -Depth 20 -Compress) -cne ($State | ConvertTo-Json -Depth 20 -Compress)) { throw 'Companion state readback differs.' }
}
