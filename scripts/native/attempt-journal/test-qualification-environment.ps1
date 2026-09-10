#requires -Version 5.1
# Real shared preflight with inert OS, measurement and directory seams.
$ErrorActionPreference='Stop'; Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'test-native-call.ps1')
. (Join-Path $PSScriptRoot 'QualificationInputs.ps1')
$script:checks=0; $script:scenario='normal'; $script:created=0
function Assert-CompanionWindows { if ($script:scenario -ceq 'platform') { throw 'Synthetic unsupported platform.' } }
function Resolve-PreparedLocalPath([string]$Path) { return $Path }
function Test-FixtureDirectory { return $script:scenario -ceq 'existing' }
# Explicit script-local OS seam; this fixture never invokes the real cmdlet.
Set-Alias -Name 'Test-Path' -Value 'Test-FixtureDirectory' -Scope Script

function Measure-PreparedPackage {
    if ($script:scenario -ceq 'original') { throw 'Synthetic changed original.' }
    return $PreparedFiles
}
function Get-FixtureProcessInventory {
    if ($script:scenario -ceq 'inventory') { throw 'Synthetic unavailable inventory.' }
    return $script:inventory
}
# Explicit script-local OS seam; this fixture never invokes the real cmdlet.
Set-Alias -Name 'Get-Process' -Value 'Get-FixtureProcessInventory' -Scope Script

function New-FixtureDirectory { $script:created++ }
# Explicit script-local OS seam; this fixture never invokes the real cmdlet.
Set-Alias -Name 'New-Item' -Value 'New-FixtureDirectory' -Scope Script

foreach ($scenario in @('normal','platform','existing','original','inventory','native','same','child','parent','long','organization','project','source')) {
    $script:scenario=$scenario; $script:created=0
    $process=[pscustomobject]@{ProcessName='unrelated';Disposed=$false}
    $process | Add-Member ScriptMethod Dispose { $this.Disposed=$true }
    $script:inventory=@($process)
    $package='C:\Original'; $output='C:\Fresh'; $organization=$binding.organizationId; $project=$binding.projectId; $commit=$source
    switch ($scenario) {
        native { $process.ProcessName='sLdWoRkS' }
        same { $output='c:\original' }
        child { $output='C:\Original\copy' }
        parent { $output='C:\'; $package='C:\Original' }
        long { $output='C:\'+('x'*43) }
        organization { $organization='invalid' }
        project { $project='invalid' }
        source { $commit='invalid' }
    }
    if ($scenario -ceq 'normal') {
        $actual=New-PreparedQualificationEnvironment $package $output $organization $project $commit
        Check ($actual.root -ceq $output -and $actual.source -ceq $package -and $actual.files.Count -eq 3 -and $script:created -eq 1) 'admitted environment preserves measured files and creates only fresh output'
    } else {
        Deny { New-PreparedQualificationEnvironment $package $output $organization $project $commit } ('preflight rejects '+$scenario)
        Check ($script:created -eq 0) ('rejected preflight creates no directory '+$scenario)
    }
    if ($scenario -in @('normal','native')) { Check $process.Disposed ('all returned process handles disposed '+$scenario) }
}
[pscustomobject]@{schema='overdrafter.qualification-environment-tests.v1';passed=$true;assertions=$script:checks;
    nativeActions=0;processes='mocked';filesystem='mocked'} | ConvertTo-Json -Compress
