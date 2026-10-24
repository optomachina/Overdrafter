$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$root=$PSScriptRoot
function HashFile($p){$h=[Security.Cryptography.SHA256]::Create();try{[BitConverter]::ToString($h.ComputeHash([IO.File]::ReadAllBytes($p))).Replace('-','').ToLowerInvariant()}finally{$h.Dispose()}}
function Inventory { @{dotnet=@(Get-Process SLDWORKS -ErrorAction SilentlyContinue|Select-Object Id,SessionId,StartTime,Path);cim=@(Get-CimInstance Win32_Process -Filter "Name='SLDWORKS.exe'"|Select-Object ProcessId,SessionId,CreationDate)} }
$a=[ordered]@{outcome='running';before=(Inventory);after=$null;sources=@();ast=@();tests=@();compile=$null;error=$null}
try {
 if($PSVersionTable.PSVersion.Major -ne 5 -or -not [Environment]::Is64BitProcess){throw 'PS5 x64 required'}
 $packet=Get-Content -Raw (Join-Path $root 'packet.json')|ConvertFrom-Json
 foreach($s in $packet.files){$p=Join-Path $root $s.path;$hash=HashFile $p;if($hash -ne $s.sha256 -or ([IO.FileInfo]$p).Length -ne $s.bytes){throw 'source drift'};$a.sources+=@{path=$p;bytes=$s.bytes;sha256=$hash}}
 foreach($p in Get-ChildItem $root -Recurse -Filter *.ps1){if($p.Name -eq 'audit.ps1'){continue};$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile($p.FullName,[ref]$tokens,[ref]$errors);$a.ast+=@{path=$p.FullName;errors=@($errors|ForEach-Object {$_.Message})};if($errors.Count){throw 'AST failure'}}
 $driver=Join-Path $root 'session-lifecycle\lifecycle.ps1'
 $tokens=$null;$errors=$null;$driverAst=[Management.Automation.Language.Parser]::ParseFile($driver,[ref]$tokens,[ref]$errors)
 foreach($name in @('Assert-CallerBinding')){$node=$driverAst.Find({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true);. ([scriptblock]::Create($node.Extent.Text))}
 $tokens=$null;$errors=$null;$extensionAst=[Management.Automation.Language.Parser]::ParseFile((Join-Path $root 'session-lifecycle\InterruptionCase.ps1'),[ref]$tokens,[ref]$errors)
 foreach($name in @('Get-FixtureIdentity','Write-ImmutableRecord','Prepare-InterruptionInputs','Assert-AttemptInputs','Assert-OriginalFixtures')){$node=$extensionAst.Find({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true);. ([scriptblock]::Create($node.Extent.Text))}
 function Save-Receipt {}
 function Assert-NoNative($reason){if(@(Get-Process SLDWORKS -ErrorAction SilentlyContinue).Count){throw $reason}}
 function Deny($name,[scriptblock]$test,$match){try{& $test;throw 'UNEXPECTED_ACCEPT'}catch{$msg=$_.Exception.Message;$a.tests+=@{name=$name;error=$msg;passed=($msg -match $match -and $msg -ne 'UNEXPECTED_ACCEPT')};if($msg -notmatch $match -or $msg -eq 'UNEXPECTED_ACCEPT'){throw}}}
 $package='C:\Users\blain\Documents\Codex\2026-09-06\create-a-new-assembly-in-solidworks\outputs\ovd-480-native-fixtures\assembly-inspection-02-7bb43d1c3d0644d0bdcf5da32c1b2dc7'
 $BaselinePath=Join-Path $package 'parts\baseline-5mm.SLDPRT';$CandidatePath=Join-Path $package 'parts\candidate-8mm.SLDPRT';$AssemblyPath=Join-Path $package 'synthetic-assembly.SLDASM'
 $ExpectedOldPid=0;$ExpectedOldTicks='';$InterruptReadonly=$false
 Deny 'assembly_without_interruption' {Assert-CallerBinding} 'Fixture paths require'
 $InterruptReadonly=$true;$ExpectedOldPid=123
 Deny 'nonzero_pid_interruption' {Assert-CallerBinding} 'Interruption requires PID zero'
 $ExpectedOldPid=0;$ExpectedOldTicks='123'
 Deny 'stale_ticks_pid_zero' {Assert-CallerBinding} 'PID zero requires empty'
 $ExpectedOldTicks='';Assert-CallerBinding
 $origAssembly=$AssemblyPath;$origCompanion=$CandidatePath
 $folder=Join-Path $root 'invalid-preparation';New-Item -ItemType Directory $folder|Out-Null
 $r=@{}
 $AssemblyPath=Join-Path $root 'missing.SLDASM'
 Deny 'missing_assembly' {Prepare-InterruptionInputs} 'Cannot find path|does not exist'
 $AssemblyPath=Join-Path $root 'wrong.SLDASM';[IO.File]::WriteAllBytes($AssemblyPath,(New-Object byte[] 59987))
 Deny 'wrong_hash_assembly' {Prepare-InterruptionInputs} 'digest mismatch'
 $AssemblyPath=$origAssembly;$CandidatePath=Join-Path $root 'missing.SLDPRT'
 Deny 'missing_companion' {Prepare-InterruptionInputs} 'Cannot find path|does not exist'
 $CandidatePath=Join-Path $root 'wrong.SLDPRT';[IO.File]::WriteAllBytes($CandidatePath,(New-Object byte[] 56171))
 Deny 'changed_companion' {Prepare-InterruptionInputs} 'digest mismatch'
 if(@(Get-ChildItem $folder).Count){throw 'invalid preparation wrote packages'}
 $CandidatePath=$origCompanion;$folder=Join-Path $root 'valid';New-Item -ItemType Directory $folder|Out-Null;$r=@{}
 Prepare-InterruptionInputs
 if($r.attempts.Count -ne 2 -or $r.attempts[0].id -eq $r.attempts[1].id -or $r.attempts[0].directory -eq $r.attempts[1].directory -or $r.attempts[0].inputManifestSha256 -eq $r.attempts[1].inputManifestSha256){throw 'packages not distinct'}
 foreach($attempt in $r.attempts){if($attempt.inputs.Count -ne 3){throw 'closure missing'};Assert-AttemptInputs $attempt}
 $a.tests+=@{name='valid_distinct_complete_packages';passed=$true;attempts=$r.attempts}

 foreach($attempt in $r.attempts){
  $m=Get-Content -Raw (Join-Path $attempt.directory 'input.json')|ConvertFrom-Json
  if($m.baseline.path -ne $origAssembly -or $m.baseline.sha256 -ne '90f017c100732cdd24d30ae01e7e64856ba65c8a9c77df4aa2f85ad4f57d9e3a' -or $m.baseline.bytes -ne 59987 -or $m.sources.Count -ne 3 -or $m.inputs.Count -ne 3 -or $m.qualification -ne 'prepared_three_file_assembly_only'){throw 'assembly manifest shape'}
  for($i=0;$i -lt 3;$i++){if($m.sources[$i].path -ne $r.sourcesBefore[$i].path -or $m.sources[$i].sha256 -ne $r.sourcesBefore[$i].sha256 -or $m.sources[$i].bytes -ne $r.sourcesBefore[$i].bytes){throw 'assembly sources identity'}}
 }
 $a.tests+=@{name='assembly_manifest_baseline_object_and_three_sources';passed=$true}
 $savedAssemblyReceipt=$r;$savedAssemblyFolder=$folder
 $AssemblyPath='';$folder=Join-Path $root 'legacy';New-Item -ItemType Directory $folder|Out-Null;$r=@{}
 Prepare-InterruptionInputs
 foreach($attempt in $r.attempts){
  Assert-AttemptInputs $attempt
  $m=Get-Content -Raw (Join-Path $attempt.directory 'input.json')|ConvertFrom-Json
  if($m.baseline.path -ne $BaselinePath -or $m.baseline.bytes -ne 56144 -or $m.baseline.sha256 -ne 'e4ff1efb9ead3efd44ad24262dee670bee7de82a894ea0a0d998a58a3fd8b8aa' -or $m.inputs.Count -ne 1 -or $attempt.inputs.Count -ne 1 -or $m.qualification -ne 'single_synthetic_part_only'){throw 'legacy manifest shape'}
 }
 $a.tests+=@{name='legacy_manifest_identity_single_input_qualification';passed=$true;attempts=$r.attempts}
 $r=$savedAssemblyReceipt;$folder=$savedAssemblyFolder;$AssemblyPath=$origAssembly
 [IO.File]::AppendAllText((Join-Path $r.attempts[0].directory 'input.json'),' ')
 Deny 'modified_manifest' {Assert-AttemptInputs $r.attempts[0]} 'manifest changed'
 $private=$r.attempts[1].inputs[2].path;$b=[IO.File]::ReadAllBytes($private);$b[0]=$b[0] -bxor 1;[IO.File]::WriteAllBytes($private,$b)
 Deny 'private_companion_modified' {Assert-AttemptInputs $r.attempts[1]} 'digest mismatch'
 Assert-OriginalFixtures
 . (Join-Path $root 'file-admission\OwnedProcess.ps1')
 $ps='C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
 $default=Invoke-OwnedProcess $ps @('-NoProfile','-NonInteractive','-File',$driver,'-OutputRoot',(Join-Path $root 'default-off'),'-ExpectedOldPid','0') 30000 (Join-Path $root 'default-off')
 $a.tests+=@{name='actual_driver_default_off';child=$default;passed=($default.exitCode -ne 0 -and $default.stderr -match 'Default-off' -and -not (Test-Path (Join-Path $root 'default-off')))}
 if(-not $a.tests[-1].passed){throw 'default off failed'}
 $compiler='C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
 $interop='C:\Program Files\SOLIDWORKS 2022\SOLIDWORKS\api\redist\SolidWorks.Interop.sldworks.dll'
 if((HashFile $compiler) -ne '46809206887326d2d24db1eff1f3064de972c3451abe766b49111450a5e08e00' -or (HashFile $interop) -ne '9284fcfb569b3e7e906e7c8d1f551e6d073f79500ba78e32c6464a53571813f0'){throw 'runtime pin drift'}
 $cs=@($packet.files|Where-Object {$_.path -like '*.cs'}|ForEach-Object {Join-Path $root $_.path});if($cs.Count -ne 7){throw 'seven sources required'}
 $binary=Join-Path $root 'NativeSessionProbe.exe'
 $args=@('/nologo','/target:exe','/platform:x64','/main:NativeSessionProbe','/reference:System.dll','/reference:System.Core.dll','/reference:System.Web.Extensions.dll',('/reference:'+$interop),('/out:'+$binary))+$cs
 $a.compile=Invoke-OwnedProcess $compiler $args 30000 (Join-Path $root 'compile')
 if($a.compile.exitCode -ne 0 -or $a.compile.timedOut){throw 'compile failed'}
 $a.binarySha256=HashFile $binary
 foreach($s in $packet.files){if((HashFile (Join-Path $root $s.path)) -ne $s.sha256){throw 'post source drift'}}
 $a.outcome='passed'
}catch{$a.outcome='failed';$a.error=$_.Exception.Message}
finally{$a.after=Inventory;[IO.File]::WriteAllText((Join-Path $root 'audit-receipt.json'),($a|ConvertTo-Json -Depth 30),[Text.UTF8Encoding]::new($false))}
