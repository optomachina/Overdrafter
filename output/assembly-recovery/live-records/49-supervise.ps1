$ErrorActionPreference='Stop'
$root=$PSScriptRoot
$src='C:\Users\blain\AppData\Local\Temp\AR-D-Dg6Drr'
function Digest($p){$h=[Security.Cryptography.SHA256]::Create();try{[BitConverter]::ToString($h.ComputeHash([IO.File]::ReadAllBytes($p))).Replace('-','').ToLowerInvariant()}finally{$h.Dispose()}}
$pkg='C:\Users\blain\Documents\Codex\2026-09-06\create-a-new-assembly-in-solidworks\outputs\ovd-480-native-fixtures\assembly-inspection-02-7bb43d1c3d0644d0bdcf5da32c1b2dc7'
function Observe { @{utc=[DateTime]::UtcNow.ToString('o');native=@(Get-Process SLDWORKS -ErrorAction SilentlyContinue|Select-Object Id,SessionId,StartTime,Path);cim=@(Get-CimInstance Win32_Process -Filter "Name='SLDWORKS.exe'"|Select-Object ProcessId,SessionId,CreationDate);policy=@(Get-ExecutionPolicy -List|ForEach-Object{@{scope=$_.Scope.ToString();value=$_.ExecutionPolicy.ToString()}});files=@(foreach($name in 'synthetic-assembly.SLDASM','parts\baseline-5mm.SLDPRT','parts\candidate-8mm.SLDPRT'){$p=Join-Path $pkg $name;@{path=$p;bytes=([IO.FileInfo]$p).Length;sha256=(Digest $p)}})} }
$r=[ordered]@{outcome='not_run';before=$null;after=$null;sources=@();pins=@();outer=$null;error=$null}
try {
 $r.before=Observe
 if($r.before.native.Count -or $r.before.cim.Count){throw 'native present'}
 $expected=@('90f017c100732cdd24d30ae01e7e64856ba65c8a9c77df4aa2f85ad4f57d9e3a','e4ff1efb9ead3efd44ad24262dee670bee7de82a894ea0a0d998a58a3fd8b8aa','b08031412dcdf878680d775d1f9d571c9556d6e9ebf9fce01f83811d36e13898')
 for($i=0;$i -lt 3;$i++){if($r.before.files[$i].sha256 -ne $expected[$i]){throw 'fixture drift'}}
 foreach($p in $r.before.policy){$expect='Undefined';if($p.scope -in 'CurrentUser','LocalMachine'){$expect='RemoteSigned'};if($p.value -ne $expect){throw 'policy drift'}}
 if($PSVersionTable.PSVersion.ToString() -ne '5.1.26100.9278' -or -not [Environment]::Is64BitProcess){throw 'runtime drift'}
 $packet=Get-Content -Raw (Join-Path $src 'packet.json')|ConvertFrom-Json
 foreach($f in $packet.files){$p=Join-Path $src $f.path;$hash=Digest $p;if($hash -ne $f.sha256 -or ([IO.FileInfo]$p).Length -ne $f.bytes){throw 'source drift'};$r.sources+=@{path=$p;bytes=$f.bytes;sha256=$hash}}
 if($r.sources.Count -ne 10){throw 'source count'}
 foreach($pin in @(
 @('C:\Program Files\SOLIDWORKS 2022\SOLIDWORKS\SLDWORKS.exe','6384c0829bac149831be5fdc9e705c90612273d25b46fdff5e5760d11e22d6cc'),
 @('C:\Program Files\SOLIDWORKS 2022\SOLIDWORKS\api\redist\SolidWorks.Interop.sldworks.dll','9284fcfb569b3e7e906e7c8d1f551e6d073f79500ba78e32c6464a53571813f0'),
 @('C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe','46809206887326d2d24db1eff1f3064de972c3451abe766b49111450a5e08e00'))){$hash=Digest $pin[0];$r.pins+=@{path=$pin[0];sha256=$hash;version=[Diagnostics.FileVersionInfo]::GetVersionInfo($pin[0]).FileVersion};if($hash -ne $pin[1]){throw 'pin drift'}}
 [IO.File]::WriteAllText((Join-Path $root 'preflight.json'),($r|ConvertTo-Json -Depth 20),[Text.UTF8Encoding]::new($false))
 . (Join-Path $src 'file-admission\OwnedProcess.ps1')
 $arguments=@('-NoProfile','-NonInteractive','-File',(Join-Path $src 'session-lifecycle\lifecycle.ps1'),'-Execute','-OutputRoot',(Join-Path $root 'run'),'-ExpectedOldPid','0','-InterruptReadonly','-AssemblyPath',(Join-Path $pkg 'synthetic-assembly.SLDASM'),'-BaselinePath',(Join-Path $pkg 'parts\baseline-5mm.SLDPRT'),'-CandidatePath',(Join-Path $pkg 'parts\candidate-8mm.SLDPRT'),'-SourceCommit','7783ce2de30c8ffc5461e4996bc1c1bc3e399495')
 # ExpectedOldTicks omitted only to use its exact declared empty-string default; PS5 native argument marshalling drops empty argv.
 $r.outer=Invoke-OwnedProcess 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' $arguments 600000 (Join-Path $root 'outer')
 $r.outcome='finished'
 if($r.outer.exitCode -ne 0 -or $r.outer.timedOut -or $r.outer.error){throw 'live driver failed'}
}catch{$r.outcome='failed';$r.error=$_.Exception.Message}
finally{$r.after=Observe;[IO.File]::WriteAllText((Join-Path $root 'supervisor.json'),($r|ConvertTo-Json -Depth 25),[Text.UTF8Encoding]::new($false))}
