#requires -Version 5.1
param([Parameter(Mandatory=$true)][string]$HostExecutable,[Parameter(Mandatory=$true)][string]$CaseRoot)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$script:hostChecks=0
function Check-Host($Value,$Label) { $script:hostChecks++; if (-not $Value) { throw ('Prepared host failed: '+$Label) } }
function Run-HostCase([string]$Name,[string]$Source,[string[]]$Parameters=@(),[switch]$WrongHash,[string]$PathArgument) {
    $path=Join-Path $CaseRoot ($Name+'.ps1'); [IO.File]::WriteAllText($path,$Source)
    $hash=(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant(); if ($WrongHash) { $hash='0'*64 }
    if ($PathArgument) { $path=$PathArgument }
    $process=New-Object OverDrafter.StopObserver.DetachedProcess
    try {
        $process.StartInfo.FileName=$HostExecutable
        $process.StartInfo.Arguments=(@(@($path,$hash)+$Parameters | ForEach-Object { '"'+$_+'"' }) -join ' ')
        $process.StartInfo.UseShellExecute=$false; $process.StartInfo.RedirectStandardOutput=$true; $process.StartInfo.RedirectStandardError=$true
        $null=$process.Start(); $stdout=$process.StandardOutput.ReadToEndAsync(); $stderr=$process.StandardError.ReadToEndAsync()
        Check-Host ($process.WaitForExit(10000)) ($Name+' bounded exit')
        Check-Host ($stdout.Wait(1000) -and $stderr.Wait(1000)) ($Name+' drained streams')
        $result=[pscustomobject]@{code=$process.ExitCode;stdout=$stdout.Result;stderr=$stderr.Result;scriptSha256=$hash}
        [IO.File]::WriteAllText((Join-Path $CaseRoot ($Name+'.result.json')),($result | ConvertTo-Json -Compress))
        return $result
    } finally { if (-not $process.HasExited) { $process.Kill(); $null=$process.WaitForExit(5000) }; $process.Dispose() }
}
$result=Run-HostCase 'success' 'param([string]$ResultPath,[switch]$Execute) if (-not $Execute) { throw "Missing switch" }; Write-Output $ResultPath; exit 0' @('-ResultPath','C:\fixture path\result.json','+Execute')
Check-Host ($result.code -eq 0 -and $result.stdout.Trim() -ceq 'C:\fixture path\result.json') 'literal output and switch preserved'
$result=Run-HostCase 'exit2' 'try { exit 2 } finally { [Console]::Out.WriteLine("unwind") }'
Check-Host ($result.code -eq 2 -and $result.stdout.Trim() -ceq 'unwind') 'explicit prepared failure code survives unwind'
foreach ($source in @('throw "fixture failure"','Write-Error "fixture failure"; exit 0','Read-Host "Forbidden prompt"')) {
    $result=Run-HostCase ('error'+$script:hostChecks) $source
    Check-Host ($result.code -ne 0) 'errors and interactive requests cannot succeed'
}
$result=Run-HostCase 'hash' '[Console]::Out.WriteLine("entered")' @() -WrongHash
Check-Host ($result.code -ne 0 -and $result.stdout -eq '') 'hash mismatch cannot enter script'
$result=Run-HostCase 'duplicate' 'param($Value) [Console]::Out.WriteLine("entered")' @('-Value','one','-value','two')
Check-Host ($result.code -ne 0 -and $result.stdout -eq '') 'case-insensitive duplicate rejection'
foreach ($relativePath in @('C:entry.ps1','\entry.ps1')) {
    $result=Run-HostCase ('relative'+$script:hostChecks) 'exit 0' -PathArgument $relativePath
    Check-Host ($result.code -ne 0 -and $result.stderr -match 'fully qualified') 'relative path rejected before file open'
}
$lockedScript=Join-Path $CaseRoot 'script-lock.ps1'
$lockSource='param($ExpectedPath) if ($PSCommandPath -cne $ExpectedPath) { throw "Script identity differs" }; try { [IO.File]::WriteAllText($PSCommandPath,"changed"); exit 0 } catch { $cause=$_.Exception.GetBaseException(); if ($cause -isnot [IO.IOException] -or ($cause.HResult -band 65535) -ne 32) { throw }; [Console]::Out.WriteLine("locked"); exit 2 }'
$result=Run-HostCase 'script-lock' $lockSource @('-ExpectedPath',$lockedScript)
$afterHash=(Get-FileHash -LiteralPath $lockedScript -Algorithm SHA256).Hash.ToLowerInvariant()
Check-Host ($result.code -eq 2 -and $result.stdout.Trim() -ceq 'locked' -and $afterHash -ceq $result.scriptSha256) 'exact hashed script rejects write sharing and remains unchanged'
[pscustomobject]@{schema='overdrafter.prepared-host-tests.v1';passed=$true;assertions=$script:hostChecks} | ConvertTo-Json -Compress
