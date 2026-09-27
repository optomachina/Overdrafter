#requires -Version 5.1
param([string]$RequestPath,[string]$CaseDirectory)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'Observer.ps1')
$request=ConvertFrom-CompanionJson ([IO.File]::ReadAllText($RequestPath))
Invoke-IndependentStopObserver -Request $request -Executable (Join-Path $PSHOME 'powershell.exe') `
    -Arguments @('-NoProfile','-NonInteractive','-File',(Join-Path $PSScriptRoot 'fixture-runner.ps1'),'-RequestPath',$RequestPath,'-CaseDirectory',$CaseDirectory,'-Scenario','long') `
    -WorkingDirectory $CaseDirectory -OutputDirectory (Join-Path $CaseDirectory 'evidence') -EnableObserver
