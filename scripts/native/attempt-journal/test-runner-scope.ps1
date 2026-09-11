#requires -Version 5.1
# In-process runspaces isolate script scope; the adapter suite mocks every
# process/storage boundary. No fixture child or native application is started.
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$runnerPath=Join-Path $PSScriptRoot 'test-runner.ps1'
$repositoryPath=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$rootPath=[IO.Path]::GetPathRoot($repositoryPath)
if ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT) { $rootPath='C:\' }
$originalDirectory=[Environment]::CurrentDirectory
$cases=@()
try {
    foreach ($directory in @($repositoryPath,$rootPath)) {
        [Environment]::CurrentDirectory=$directory
        $engine=[PowerShell]::Create()
        try {
            # The call operator creates the same script-scope boundary as the
            # retained qualification wrapper. Do not dot-source the test here.
            $null=$engine.AddScript({
                param($Path,$ExpectedDirectory)
                $ErrorActionPreference='Stop'
                if ([Environment]::CurrentDirectory -cne $ExpectedDirectory) { throw 'Working directory was not inherited.' }
                & $Path
                if ([Environment]::CurrentDirectory -cne $ExpectedDirectory) { throw 'Adapter changed the inherited working directory.' }
            }.ToString()).AddArgument($runnerPath).AddArgument($directory)
            $output=@(); $errors=@()
            try { $output=@($engine.Invoke()) } catch { $errors += $_.Exception.Message }
            $errors += @($engine.Streams.Error | ForEach-Object { $_.ToString() })
            $summary=$null
            if ($errors.Count -eq 0 -and -not $engine.HadErrors -and $output.Count -eq 1) { $summary=$output[0].ToString() | ConvertFrom-Json }
            $passed=$null -ne $summary -and $summary.schema -ceq 'overdrafter.journal-runner-tests.v1' -and
                $summary.passed -eq $true -and $summary.assertions -gt 0 -and $summary.nativeActions -eq 0 -and
                $summary.processes -ceq 'mocked' -and $summary.storage -ceq 'mocked'
            $assertions=0
            if ($passed) { $assertions=$summary.assertions }
            $cases += [pscustomobject]@{directory=$directory;invocation='nested-call-operator';passed=$passed;
                adapterAssertions=$assertions;errors=$errors}
        } finally { $engine.Dispose() }
    }
} finally { [Environment]::CurrentDirectory=$originalDirectory }
$passed=@($cases | Where-Object { -not $_.passed }).Count -eq 0
[pscustomobject]@{schema='overdrafter.journal-runner-scope-tests.v1';passed=$passed;cases=$cases;
    nativeActions=0;processes='mocked';storage='mocked';directoryRestored=([Environment]::CurrentDirectory -ceq $originalDirectory)} |
    ConvertTo-Json -Depth 6 -Compress
if (-not $passed) { throw 'Nested adapter scope regression failed; inspect the per-directory results.' }
