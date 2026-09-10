#requires -Version 5.1
# Exercise the actual compiler argument construction without compiling or starting
# processes. Qualification hooks must never enter the ordinary or lifecycle build.
$ErrorActionPreference='Stop'; Set-StrictMode -Version Latest
$tokens=$null; $errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot '../prepared-dimension/run.ps1'),[ref]$tokens,[ref]$errors)
if ($errors.Count -ne 0) { throw 'Prepared runner does not parse.' }
$definition=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Build-PreparedHelpers'},$true)
if ($null -eq $definition) { throw 'Actual helper builder missing.' }
. ([scriptblock]::Create($definition.Extent.Text))
$folder='C:\Private\attempt'; $interop='C:\Qualified\Interop.dll'; $journalSession=$null
$script:invocations=@(); $script:checks=0
function Check([bool]$Value,[string]$Label) { $script:checks++; if (-not $Value) { throw ('Native call build test failed: '+$Label) } }
function Join-Path([string]$Path,[string]$ChildPath) {
    if (-not $Path) { $Path='C:\Windows' }
    return $Path.TrimEnd('\')+'\'+$ChildPath
}
function Get-Item { return [pscustomobject]@{VersionInfo=[pscustomobject]@{FileVersion='4.8.9221.0'}} }
function Get-PreparedHash([string]$Path) {
    if ($Path.EndsWith('csc.exe')) { return '46809206887326d2d24db1eff1f3064de972c3451abe766b49111450a5e08e00' }
    return 'd'*64
}
function Save-PreparedProgress {}
function Invoke-PreparedChild($Role,$Executable,$Arguments,$TimeoutMs,$LogBase,$Journal) {
    Check ($Role -ceq 'compiler' -and $Executable.EndsWith('csc.exe') -and $TimeoutMs -eq 30000) 'bounded compiler invocation'
    $script:invocations+=,@($Arguments)
    return [pscustomobject]@{error=$null;timedOut=$false;exitCode=0}
}
foreach ($selected in @($false,$true)) {
    $qualifyNativeCall=$selected; $script:invocations=@()
    $supervisor=@{compiler=$null;stage='';observations=@();binaries=@{}}
    Build-PreparedHelpers
    Check ($script:invocations.Count -eq 2) 'exactly lifecycle and operation builds'
    $lifecycle=$script:invocations[0]; $operation=$script:invocations[1]
    Check ($lifecycle -ccontains '/main:NativeSessionProbe') 'first build is lifecycle helper'
    Check ($operation -ccontains '/main:PreparedDimensionProbe') 'second build is operation helper'
    Check (@($lifecycle | Where-Object {$_ -like '*OVD_QUALIFY*' -or $_ -like '*NativeCallQualification.cs'}).Count -eq 0) 'lifecycle excludes hooks'
    $defines=@($operation | Where-Object {$_ -ceq '/define:OVD_QUALIFY_NATIVE_CALL'})
    $sources=@($operation | Where-Object {$_ -ceq ($folder+'\NativeCallQualification.cs')})
    if ($selected) { Check ($defines.Count -eq 1 -and $sources.Count -eq 1) 'qualification compiles the hook explicitly' }
    else { Check ($defines.Count -eq 0 -and $sources.Count -eq 0) 'ordinary operation excludes hooks' }
}
[pscustomobject]@{schema='overdrafter.native-call-build-tests.v1';passed=$true;assertions=$script:checks;nativeActions=0} | ConvertTo-Json -Compress
