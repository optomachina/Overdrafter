# Internal frozen synthetic wire contract. Loading this file performs no native action.
$PreparedChecks = @('input_identity', 'native_integrity', 'dimension', 'assembly_references',
    'component_placements', 'save_reopen', 'source_preservation')
$PreparedFiles = @(
    [ordered]@{ path = 'synthetic-assembly.SLDASM'; bytes = 59987; sha256 = '90f017c100732cdd24d30ae01e7e64856ba65c8a9c77df4aa2f85ad4f57d9e3a' },
    [ordered]@{ path = 'parts/baseline-5mm.SLDPRT'; bytes = 56144; sha256 = 'e4ff1efb9ead3efd44ad24262dee670bee7de82a894ea0a0d998a58a3fd8b8aa' },
    [ordered]@{ path = 'parts/candidate-8mm.SLDPRT'; bytes = 56171; sha256 = 'b08031412dcdf878680d775d1f9d571c9556d6e9ebf9fce01f83811d36e13898' })
$PreparedLimitations = @('Synthetic fixed assembly; no mates or drawings.',
    'Imported operator evidence; source freshness is rechecked by the runner.')

function Get-PreparedHash([string]$Path) {
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
}
function Get-PreparedBytesHash([byte[]]$Bytes) {
    $hash = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($hash.ComputeHash($Bytes)).Replace('-', '').ToLowerInvariant() }
    finally { $hash.Dispose() }
}
function Test-PreparedText($Value, [string]$Expected) {
    return ($Value -is [string] -and $Value -ceq $Expected)
}
function Write-PreparedBytes([string]$Path, [byte[]]$Bytes) {
    $stream = New-Object IO.FileStream($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
    try { $stream.Write($Bytes, 0, $Bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
    return Get-PreparedHash $Path
}
function Write-PreparedJson([string]$Path, $Value) {
    $encoding = New-Object Text.UTF8Encoding($false, $true)
    return Write-PreparedBytes $Path ($encoding.GetBytes(($Value | ConvertTo-Json -Depth 40) + "`n"))
}
function Read-PreparedJson([string]$Path) {
    $bytes = [IO.File]::ReadAllBytes($Path)
    if ($bytes.Length -eq 0 -or $bytes.Length -gt 65536 -or
        ($bytes.Length -ge 3 -and $bytes[0] -eq 239 -and $bytes[1] -eq 187 -and $bytes[2] -eq 191)) {
        throw 'Expected a nonempty UTF-8 JSON file without BOM, at most 64 KiB.'
    }
    $encoding = New-Object Text.UTF8Encoding($false, $true)
    $text = $encoding.GetString($bytes)
    return @{ bytes = $bytes; value = ($text | ConvertFrom-Json -ErrorAction Stop); sha256 = (Get-PreparedBytesHash $bytes) }
}
function Assert-PreparedKeys($Value, [string[]]$Keys) {
    if ($null -eq $Value -or $Value -isnot [pscustomobject]) { throw 'Expected a JSON object.' }
    $actual = @($Value.PSObject.Properties.Name)
    if ($actual.Count -ne $Keys.Count) { throw 'Unexpected JSON object fields.' }
    foreach ($key in $Keys) { if ($actual -cnotcontains $key) { throw ('Missing exact field: ' + $key) } }
}
function Assert-PreparedScope($Scope) {
    Assert-PreparedKeys $Scope @('organizationId', 'projectId')
    if (-not (Test-PreparedText $Scope.organizationId 'local-engineering') -or
        -not (Test-PreparedText $Scope.projectId 'prepared-assembly')) { throw 'Scope mismatch.' }
}
function Test-PreparedNumber($Value) {
    return (($Value -is [int] -or $Value -is [long] -or $Value -is [double] -or $Value -is [decimal]) -and
        -not [double]::IsNaN([double]$Value) -and -not [double]::IsInfinity([double]$Value))
}
function Assert-PreparedTime($Value) {
    $date = [DateTime]::MinValue
    if ($Value -isnot [string] -or -not [DateTime]::TryParseExact($Value, "yyyy-MM-dd'T'HH:mm:ss.fff'Z'",
        [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal, [ref]$date)) {
        throw 'Expected canonical UTC timestamp with milliseconds.'
    }
}
function Assert-PreparedFiles($Files) {
    if ($Files -isnot [array] -or $Files.Count -ne 3) { throw 'Exactly three input identities required.' }
    for ($index = 0; $index -lt 3; $index++) {
        $file = $Files[$index]; $expected = $PreparedFiles[$index]
        Assert-PreparedKeys $file @('path', 'bytes', 'sha256')
        if (-not (Test-PreparedText $file.path $expected.path) -or -not (Test-PreparedNumber $file.bytes) -or
            $file.bytes -ne $expected.bytes -or -not (Test-PreparedText $file.sha256 $expected.sha256)) { throw 'Prepared input identity mismatch.' }
    }
}
function Assert-PreparedContext($Context) {
    Assert-PreparedKeys $Context @('schema', 'packageId', 'scope', 'capturedAt', 'configuration', 'assemblyPath', 'files', 'dimension', 'limitations')
    if (-not (Test-PreparedText $Context.schema 'overdrafter.prepared-assembly.v1') -or
        -not (Test-PreparedText $Context.packageId 'ovd-native04-assembly') -or
        -not (Test-PreparedText $Context.configuration 'Default') -or
        -not (Test-PreparedText $Context.assemblyPath 'synthetic-assembly.SLDASM')) { throw 'Unsupported prepared context.' }
    Assert-PreparedScope $Context.scope; Assert-PreparedTime $Context.capturedAt; Assert-PreparedFiles $Context.files
    $dimension = $Context.dimension
    Assert-PreparedKeys $dimension @('id', 'occurrence', 'feature', 'partPath', 'unit', 'baseline', 'minimum', 'maximum')
    if (-not (Test-PreparedText $dimension.id 'baseline-depth') -or -not (Test-PreparedText $dimension.occurrence 'baseline-5mm-1') -or
        -not (Test-PreparedText $dimension.feature 'OVD_QualificationExtrusion') -or
        -not (Test-PreparedText $dimension.partPath 'parts/baseline-5mm.SLDPRT') -or
        -not (Test-PreparedText $dimension.unit 'mm')) { throw 'Unsupported driving dimension.' }
    foreach ($entry in @(@('baseline', 5), @('minimum', 6), @('maximum', 10))) {
        $value = $dimension.($entry[0])
        if (-not (Test-PreparedNumber $value) -or $value -ne $entry[1]) { throw 'Dimension bounds mismatch.' }
    }
    if ($Context.limitations -isnot [array] -or $Context.limitations.Count -ne 2) { throw 'Context limitations mismatch.' }
    for ($i = 0; $i -lt 2; $i++) { if (-not (Test-PreparedText $Context.limitations[$i] $PreparedLimitations[$i])) { throw 'Context limitations mismatch.' } }
}
function Assert-PreparedJob($Job) {
    Assert-PreparedKeys $Job @('schema', 'jobId', 'attemptId', 'scope', 'contextSha256', 'inputFiles',
        'dimensionId', 'depthMm', 'configuration', 'createdAt', 'requiredChecks')
    if (-not (Test-PreparedText $Job.schema 'overdrafter.prepared-dimension-job.v1') -or
        -not (Test-PreparedText $Job.dimensionId 'baseline-depth') -or -not (Test-PreparedText $Job.configuration 'Default') -or
        $Job.contextSha256 -isnot [string] -or $Job.contextSha256 -cnotmatch '^[0-9a-f]{64}$') { throw 'Unsupported prepared job.' }
    foreach ($id in @($Job.jobId, $Job.attemptId)) {
        if ($id -isnot [string] -or $id -cnotmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') { throw 'Canonical UUID required.' }
    }
    Assert-PreparedScope $Job.scope; Assert-PreparedTime $Job.createdAt; Assert-PreparedFiles $Job.inputFiles
    if (-not (Test-PreparedNumber $Job.depthMm) -or $Job.depthMm -lt 6 -or $Job.depthMm -gt 10) { throw 'Depth must be a finite number from 6 to 10 mm.' }
    if ($Job.requiredChecks -isnot [array] -or $Job.requiredChecks.Count -ne 7) { throw 'All seven checks are required.' }
    for ($i = 0; $i -lt 7; $i++) { if (-not (Test-PreparedText $Job.requiredChecks[$i] $PreparedChecks[$i])) { throw 'Required check set mismatch.' } }
}
# These are bounded trusted-local file checks, not reparse/race-resistant sandbox admission.
function Resolve-PreparedLocalPath([string]$Path) {
    if ([string]::IsNullOrWhiteSpace($Path) -or $Path -notmatch '^[A-Za-z]:[\\/]' -or $Path -match '["\r\n]') {
        throw 'A trusted absolute local Windows path is required.'
    }
    return [IO.Path]::GetFullPath($Path)
}
function Measure-PreparedPackage([string]$Root, [switch]$RequireOriginal) {
    $rootPath = Resolve-PreparedLocalPath $Root
    $records = @()
    foreach ($expected in $PreparedFiles) {
        $path = Join-Path $rootPath $expected.path
        $file = Get-Item -LiteralPath $path -ErrorAction Stop
        if ($file.PSIsContainer -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Expected a regular synthetic native file.' }
        $record = [ordered]@{ path = $expected.path; bytes = $file.Length; sha256 = (Get-PreparedHash $path) }
        if ($RequireOriginal -and ($record.bytes -ne $expected.bytes -or $record.sha256 -cne $expected.sha256)) {
            throw ('Original synthetic file differs: ' + $expected.path)
        }
        $records += $record
    }
    return ,$records
}
