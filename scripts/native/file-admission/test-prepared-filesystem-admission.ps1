#requires -Version 5.1
# Synthetic Windows cases for OVD-509. Never invokes SolidWorks or a server.
[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$OutputRoot)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or
    -not [Environment]::Is64BitProcess -or $PSVersionTable.PSVersion.Major -ne 5 -or
    $PSVersionTable.PSVersion.Minor -ne 1) { throw 'Requires x64 Windows PowerShell 5.1.' }
$source = Join-Path $PSScriptRoot 'PreparedFilesystemAdmission.cs'
$sourceHash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant()
Add-Type -TypeDefinition ([IO.File]::ReadAllText($source)) -ErrorAction Stop
$root = Join-Path $OutputRoot ('ovd509-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root -ErrorAction Stop | Out-Null
$inputRoot = Join-Path $root 'input'
$output = Join-Path $root 'output'
New-Item -ItemType Directory -Path (Join-Path $inputRoot 'parts') -Force -ErrorAction Stop | Out-Null
New-Item -ItemType Directory -Path $output -ErrorAction Stop | Out-Null
$required = @('synthetic-assembly.SLDASM', 'parts\baseline-5mm.SLDPRT', 'parts\candidate-8mm.SLDPRT')
foreach ($name in $required) {
    $path = Join-Path $inputRoot $name
    [IO.File]::WriteAllText($path, ('synthetic ' + $name), (New-Object Text.UTF8Encoding($false)))
}
$originalHashes = @($required | ForEach-Object { (Get-FileHash -LiteralPath (Join-Path $inputRoot $_) -Algorithm SHA256).Hash })
$cases = New-Object Collections.Generic.List[object]
function Record([string]$Name, [bool]$Passed, [string]$Detail) {
    $cases.Add([pscustomobject]@{ name=$Name; passed=$Passed; detail=$Detail })
}
function Expect-Rejection([string]$Name, [string]$ExpectedError, [scriptblock]$Action) {
    try { & $Action; Record $Name $false 'Unexpected admission.' }
    catch { Record $Name ($_.Exception.Message -match $ExpectedError) $_.Exception.GetType().Name }
}
function New-Attempt([string]$Parent, [Guid]$Id) {
    $folder = Join-Path $Parent $Id.ToString('D')
    New-Item -ItemType Directory -Path (Join-Path $folder 'candidate\parts') -Force -ErrorAction Stop | Out-Null
    return $folder
}

$attempt = [Guid]::NewGuid()
$guard = $null
try {
    $guard = [PreparedFilesystemAdmission]::Begin($inputRoot, $output, $attempt.ToString('D'))
    $folder = New-Attempt $output $attempt
    $guard.BindAttemptDirectory($folder)
    $candidate = Join-Path $folder 'candidate'
    $guard.BindCandidateDirectories($candidate)
    foreach ($name in $required) { [IO.File]::Copy((Join-Path $inputRoot $name), (Join-Path $candidate $name), $false) }
    $guard.BindCandidateFiles()
    $guard.Recheck()
    $identityValid = $guard.input.volumeSerial -cmatch '^[0-9a-f]{16}$' -and
        $guard.input.fileId -cmatch '^[0-9a-f]{32}$' -and
        $guard.candidate.fileId -cmatch '^[0-9a-f]{32}$' -and
        $guard.input.fileId -cne $guard.candidate.fileId -and
        $guard.attemptId -ceq $attempt.ToString('D')
    Record 'handle_identities_and_attempt_binding' $identityValid 'FILE_ID_INFO from held handles'
    Expect-Rejection 'input_write_denied' 'sharing|used by another process|access.*denied' {
        $file = New-Object IO.FileStream((Join-Path $inputRoot $required[0]), [IO.FileMode]::Open,
            [IO.FileAccess]::Write, [IO.FileShare]::ReadWrite)
        $file.Dispose()
    }
    Expect-Rejection 'input_file_replacement_denied' 'sharing|used by another process|access.*denied' { [IO.File]::Move((Join-Path $inputRoot $required[0]), (Join-Path $inputRoot 'moved.SLDASM')) }
    Expect-Rejection 'attempt_replacement_denied' 'sharing|used by another process|access.*denied' { [IO.Directory]::Move($folder, ($folder + '-moved')) }
    Expect-Rejection 'candidate_directory_replacement_denied' 'sharing|used by another process|access.*denied' { [IO.Directory]::Move($candidate, ($candidate + '-moved')) }
    Expect-Rejection 'candidate_file_replacement_denied' 'sharing|used by another process|access.*denied' { [IO.File]::Move((Join-Path $candidate $required[0]), (Join-Path $candidate 'moved.SLDASM')) }
    $guard.Recheck()
    Record 'recheck_after_denied_mutations' $true 'Held identity remained stable'
} finally { if ($null -ne $guard) { $guard.Dispose() } }

# A junction must be rejected before any native process is started.
$junctionInput = Join-Path $root 'input-junction'
$mklink = Start-Process -FilePath 'cmd.exe' -ArgumentList @('/c', 'mklink', '/J', ('"' + $junctionInput + '"'), ('"' + $inputRoot + '"')) -Wait -PassThru -NoNewWindow
if ($mklink.ExitCode -ne 0) { throw 'Could not create synthetic junction.' }
Expect-Rejection 'junction_denied' 'Reparse point' {
    $alias = [PreparedFilesystemAdmission]::Begin($junctionInput, $output, ([Guid]::NewGuid().ToString('D')))
    $alias.Dispose()
}

$symlinkInput = Join-Path $root 'input-symlink'
$mklink = Start-Process -FilePath 'cmd.exe' -ArgumentList @('/c', 'mklink', '/D', ('"' + $symlinkInput + '"'), ('"' + $inputRoot + '"')) -Wait -PassThru -NoNewWindow
if ($mklink.ExitCode -ne 0) { throw 'Could not create synthetic directory symlink; exact-head symlink qualification is incomplete.' }
Expect-Rejection 'symlink_denied' 'Reparse point' {
    $alias = [PreparedFilesystemAdmission]::Begin($symlinkInput, $output, ([Guid]::NewGuid().ToString('D')))
    $alias.Dispose()
}
Expect-Rejection 'missing_root_denied' 'identity could not be opened' {
    $alias = [PreparedFilesystemAdmission]::Begin((Join-Path $root 'missing'), $output, ([Guid]::NewGuid().ToString('D')))
    $alias.Dispose()
}

# A hard link of a required descendant must not be admitted as a candidate.
$attempt2 = [Guid]::NewGuid()
$folder = New-Attempt $output $attempt2
$candidate = Join-Path $folder 'candidate'
foreach ($name in $required) {
    if ($name -eq $required[0]) {
        $link = Join-Path $candidate $name
        $mklink = Start-Process -FilePath 'cmd.exe' -ArgumentList @('/c', 'mklink', '/H', ('"' + $link + '"'), ('"' + (Join-Path $inputRoot $name) + '"')) -Wait -PassThru -NoNewWindow
        if ($mklink.ExitCode -ne 0) { throw 'Could not create synthetic hard link.' }
    } else { [IO.File]::Copy((Join-Path $inputRoot $name), (Join-Path $candidate $name), $false) }
}
try {
    Expect-Rejection 'descendant_hardlink_denied' 'Hard-linked prepared file' {
        $alias = [PreparedFilesystemAdmission]::Begin($inputRoot, $output, $attempt2.ToString('D'))
        $alias.Dispose()
    }
} finally {
    [IO.File]::Delete((Join-Path $candidate $required[0]))
}

$external = Join-Path $root 'external.bin'
[IO.File]::WriteAllText($external, 'synthetic external file', (New-Object Text.UTF8Encoding($false)))
$attempt3 = [Guid]::NewGuid()
$folder = New-Attempt $output $attempt3
$candidate = Join-Path $folder 'candidate'
foreach ($name in $required) {
    if ($name -eq $required[0]) {
        $link = Join-Path $candidate $name
        $mklink = Start-Process -FilePath 'cmd.exe' -ArgumentList @('/c', 'mklink', '/H', ('"' + $link + '"'), ('"' + $external + '"')) -Wait -PassThru -NoNewWindow
        if ($mklink.ExitCode -ne 0) { throw 'Could not create synthetic external hard link.' }
    } else { [IO.File]::Copy((Join-Path $inputRoot $name), (Join-Path $candidate $name), $false) }
}
$guard = $null
try {
    $guard = [PreparedFilesystemAdmission]::Begin($inputRoot, $output, $attempt3.ToString('D'))
    $guard.BindAttemptDirectory($folder)
    $guard.BindCandidateDirectories($candidate)
    Expect-Rejection 'external_hardlink_denied' 'Hard-linked prepared file' { $guard.BindCandidateFiles() }
} finally { if ($null -ne $guard) { $guard.Dispose() } }

$drive = @('Z:', 'Y:', 'X:') | Where-Object { -not (Test-Path ($_ + '\')) } | Select-Object -First 1
if (-not $drive) { throw 'No free synthetic substituted-drive letter.' }
try {
    $subst = Start-Process -FilePath 'subst.exe' -ArgumentList @($drive, $root) -Wait -PassThru -NoNewWindow
    if ($subst.ExitCode -ne 0) { throw 'Could not create substituted drive.' }
    $mappedInput = Join-Path ($drive + '\') 'input'
    Expect-Rejection 'substituted_drive_denied' 'Substituted or unsupported drive' {
        $alias = [PreparedFilesystemAdmission]::Begin($mappedInput, $output, ([Guid]::NewGuid().ToString('D')))
        $alias.Dispose()
    }
} finally { & subst.exe $drive /D | Out-Null }

$afterHashes = @($required | ForEach-Object { (Get-FileHash -LiteralPath (Join-Path $inputRoot $_) -Algorithm SHA256).Hash })
Record 'source_files_unchanged' (($originalHashes -join ',') -ceq ($afterHashes -join ',')) 'Exact SHA-256 readback'
$passed = @($cases | Where-Object { -not $_.passed }).Count -eq 0 -and $cases.Count -eq 14
# Windows PowerShell 5.1 cannot bind @($cases) for this generic List here.
$receipt = [ordered]@{ schema='overdrafter.ovd509.synthetic-windows-cases.v1'; sourceSha256=$sourceHash;
    outputRoot=$root; nativeCalls=0; cases=$cases.ToArray(); outcome=$(if ($passed) { 'passed' } else { 'failed' });
    limitation='Synthetic filesystem qualification only; fresh SolidWorks execution and connected server admission remain separate.' }
$path = Join-Path $root 'result.json'
[IO.File]::WriteAllText($path, (($receipt | ConvertTo-Json -Depth 20) + "`n"), (New-Object Text.UTF8Encoding($false)))
Write-Output $path
if (-not $passed) { exit 1 }
