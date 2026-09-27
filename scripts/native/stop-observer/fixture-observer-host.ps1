#requires -Version 5.1
param([string]$RequestPath,[string]$CaseDirectory)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'Observer.ps1')
$request=ConvertFrom-CompanionJson ([IO.File]::ReadAllText($RequestPath))
Invoke-IndependentStopObserver -Request $request -Executable (Join-Path ([IO.Directory]::GetParent($CaseDirectory).FullName) 'FixtureRunner.exe') `
    -Arguments @((Join-Path $PSScriptRoot 'fixture-runner.ps1'),$RequestPath,$CaseDirectory,'long') `
    -WorkingDirectory $CaseDirectory -OutputDirectory (Join-Path $CaseDirectory 'evidence') -EnableObserver
