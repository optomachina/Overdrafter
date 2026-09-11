#requires -Version 5.1
# Exercise the actual operation observer through nested script scope. Journal
# and process seams stay mocked; only disposable checkpoint files are written.
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$testPath=Join-Path $PSScriptRoot 'test-native-call-acknowledgment.ps1'
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
            $null=$engine.AddScript({
                param($Path,$ExpectedDirectory)
                $ErrorActionPreference='Stop'
                if ([Environment]::CurrentDirectory -cne $ExpectedDirectory) { throw 'Working directory was not inherited.' }
                # Keep the primary receipt, not repeated prerequisite summaries.
                # The call operator must preserve the qualification wrapper's
                # nested script-scope boundary; do not dot-source the test here.
                & $Path | ForEach-Object { $_ | ConvertFrom-Json } |
                    Where-Object { $_.schema -ceq 'overdrafter.native-call-acknowledgment-tests.v1' } |
                    ConvertTo-Json -Compress
                if ([Environment]::CurrentDirectory -cne $ExpectedDirectory) { throw 'Observer changed the inherited working directory.' }
            }.ToString()).AddArgument($testPath).AddArgument($directory)
            $output=@(); $errors=@()
            try { $output=@($engine.Invoke()) } catch { $errors += $_.Exception.Message }
            $errors += @($engine.Streams.Error | ForEach-Object { $_.ToString() })
            $summary=$null
            if ($errors.Count -eq 0 -and -not $engine.HadErrors -and $output.Count -eq 1) { $summary=$output[0].ToString() | ConvertFrom-Json }
            $passed=$null -ne $summary -and $summary.passed -eq $true -and $summary.assertions -gt 0 -and
                $summary.nativeActions -eq 0 -and $summary.processes -ceq 'mocked' -and
                $summary.journalStore -ceq 'mocked' -and $summary.checkpointFiles -ceq 'real temporary files'
            $assertions=0
            if ($passed) { $assertions=$summary.assertions }
            $cases += [pscustomobject]@{directory=$directory;invocation='nested-call-operator';passed=$passed;
                acknowledgmentAssertions=$assertions;errors=$errors}
        } finally { $engine.Dispose() }
    }
} finally { [Environment]::CurrentDirectory=$originalDirectory }
$passed=@($cases | Where-Object { -not $_.passed }).Count -eq 0
[pscustomobject]@{schema='overdrafter.native-call-acknowledgment-scope-tests.v1';passed=$passed;cases=$cases;
    nativeActions=0;processes='mocked';journalStore='mocked';checkpointFiles='real temporary files';
    directoryRestored=([Environment]::CurrentDirectory -ceq $originalDirectory)} | ConvertTo-Json -Depth 6 -Compress
if (-not $passed) { throw 'Nested operation acknowledgment regression failed; inspect the per-directory results.' }
