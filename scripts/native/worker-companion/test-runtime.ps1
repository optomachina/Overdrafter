#requires -Version 5.1
# Inert Windows composition: real pinned engine/compiler + async observer + pipe
# transfer; no credential, network, SolidWorks installation or CAD invocation.
$ErrorActionPreference='Stop'; Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'CompanionRuntime.ps1')
. (Join-Path $PSScriptRoot '../stop-observer/Observer.ps1')
Assert-CompanionWindows
$vswhere=Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$compilers=@(& $vswhere -latest -products '*' -requires Microsoft.Component.MSBuild -find 'MSBuild\Current\Bin\Roslyn\csc.exe')
if ($LASTEXITCODE -ne 0 -or $compilers.Count -ne 1) { throw 'One installed standalone compiler required.' }
$base=$env:TEMP; if ($env:RUNNER_TEMP) { $base=$env:RUNNER_TEMP }
$root=Join-Path $base ('ovd562-runtime-'+[Guid]::NewGuid().ToString())
$prepared=(& (Join-Path $PSScriptRoot 'prepare-runtime.ps1') -Prepare -OutputDirectory $root -CompilerPath $compilers[0]) | ConvertFrom-Json
$runtime=$null
try {
    $denied=$false
    try { $null=Open-CompanionRuntime $prepared.profilePath ('0'*64) } catch { $denied=$_.ToString() -match 'profile hash differs' }
    if (-not $denied) { throw 'Changed profile accepted.' }
    $runtime=Open-CompanionRuntime $prepared.profilePath $prepared.sha256
    Import-CompanionRuntime $runtime
    $denied=$false
    try { $stream=[IO.File]::Open($runtime.profile.host.path,[IO.FileMode]::Open,[IO.FileAccess]::Write,[IO.FileShare]::Read); $stream.Dispose() }
    catch { $denied=$true }
    if (-not $denied) { throw 'Admitted host was writable during observation.' }
    Add-Type -Path (Join-Path $PSScriptRoot '../stop-observer/FixturePipeEvidence.cs')
    foreach ($scenario in @('complete','withheld_authority')) {
        $directory=Join-Path $root $scenario
        $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
        try { $sid=$identity.User } finally { $identity.Dispose() }
        (New-Object IO.DirectoryInfo($directory)).Create((New-CompanionAcl $sid $true))
        $binding=[pscustomobject]@{organizationId=[Guid]::NewGuid().ToString();projectId=[Guid]::NewGuid().ToString();workerId=[Guid]::NewGuid().ToString();
            installationId=[Guid]::NewGuid().ToString();bootId=[Guid]::NewGuid().ToString();taskId=[Guid]::NewGuid().ToString();attemptId=[Guid]::NewGuid().ToString();
            jobId=[Guid]::NewGuid().ToString();fence=1;jobSha256=('c'*64);runtimeAdmissionId=[Guid]::NewGuid().ToString()}
        $seconds=60; if ($scenario -ceq 'withheld_authority') { $seconds=5 }
        $request=[pscustomobject]@{binding=$binding;contextSha256=('d'*64);deadline=(Format-StopTime ([DateTimeOffset]::UtcNow.AddSeconds($seconds)));observerRunId=[Guid]::NewGuid().ToString()}
        $path=Join-Path $directory 'request.json'; [IO.File]::WriteAllText($path,(ConvertTo-JournalJson $request))
        $send=New-Object IO.Pipes.AnonymousPipeServerStream([IO.Pipes.PipeDirection]::Out,[IO.HandleInheritability]::Inheritable)
        $receive=New-Object IO.Pipes.AnonymousPipeServerStream([IO.Pipes.PipeDirection]::In,[IO.HandleInheritability]::Inheritable)
        $observation=$null
        try {
            $reader=New-Object IO.StreamReader($receive)
            $reply=[FixturePipeReceipt]::Read($reader,(Join-Path $directory 'authority-eof-release'))
            if ($scenario -ceq 'complete') {
                $writer=New-Object IO.StreamWriter($send); $writer.AutoFlush=$true; $writer.WriteLine('fixture-authority')
            }
            $entry=Join-Path $PSScriptRoot '../stop-observer/fixture-console-runner.ps1'
            $arguments=@($entry,(Get-CompanionRuntimeFile $entry).sha256,'-RequestPath',$path,'-CaseDirectory',$directory,
                '-ReadHandle',$send.GetClientHandleAsString(),'-WriteHandle',$receive.GetClientHandleAsString(),
                '-CompilerPath',$runtime.profile.compiler.path,'-CompilerSha256',$runtime.profile.compiler.sha256)
            $observation=Start-CompanionObservation $request $runtime $arguments $directory (Join-Path $directory 'evidence') @($send,$receive)
            if (-not $observation.pending.AsyncWaitHandle.WaitOne(70000)) { throw 'Async observer exceeded finite deadline.' }
            if ($scenario -ceq 'complete') {
                $certificate=Complete-CompanionObservation $observation
                $manifest=ConvertFrom-CompanionJson ([IO.File]::ReadAllText($certificate.manifestPath))
                if ($manifest.totalProcesses -ne 5 -or $manifest.terminalProcesses.Count -ne 4 -or $manifest.root.exitCode -ne 0 -or
                    $manifest.nativeQualification -ne $false -or -not $reply.Wait(1000) -or $reply.Result.Text.Trim() -cne 'fixture-authority-ack') {
                    throw 'Pinned engine/compiler/observer/pipe composition differs.'
                }
            } else {
                $denied=$false
                try { $null=Complete-CompanionObservation $observation } catch { $denied=$true }
                if (-not $denied -or -not [IO.File]::Exists((Join-Path $directory 'console-ready')) -or
                    [IO.File]::Exists((Join-Path $directory 'evidence/manifest.json')) -or -not $reply.Wait(5000)) {
                    throw 'Withheld authority failed to deny entered root without certificate.'
                }
            }
        } finally {
            if ($null -ne $observation) { $observation.pipeline.Dispose() }
            $send.Dispose(); $receive.Dispose()
        }
    }
    [pscustomobject]@{schema='overdrafter.companion-runtime-test.v1';passed=$true;nativeActions=0;network=$false;
        evidenceRoot=$root;runtimeProfileSha256=$prepared.sha256;nativeQualification=$false} | ConvertTo-Json -Compress
} finally { Close-CompanionRuntime $runtime }
