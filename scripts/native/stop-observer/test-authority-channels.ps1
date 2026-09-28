#requires -Version 5.1
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'Observer.ps1')
# Only pre-launch validation is exercised here. The sentinel proves accepted
# channels reached path validation without constructing any process boundary.
function Assert-CompanionWindows {}
function Assert-StopRequest($Request) {}
function Assert-CompanionLocalPath($Path) { throw 'fixture pre-launch sentinel' }
$request=[pscustomobject]@{deadline=(Format-StopTime ([DateTimeOffset]::UtcNow.AddMinutes(1)))}
$channels=@()
$checks=0
try {
    foreach ($direction in @('Out','Out','In','In')) {
        $channels+=New-Object IO.Pipes.AnonymousPipeServerStream([IO.Pipes.PipeDirection]::$direction,[IO.HandleInheritability]::Inheritable)
    }
    $cases=@(
        @{name='two writers';pair=@($channels[0],$channels[1]);expected='Authority pipes must be ordered Out then In.'},
        @{name='two readers';pair=@($channels[2],$channels[3]);expected='Authority pipes must be ordered Out then In.'},
        @{name='reversed pair';pair=@($channels[2],$channels[0]);expected='Authority pipes must be ordered Out then In.'},
        @{name='duplicate channel';pair=@($channels[0],$channels[0]);expected='Authority pipes must be ordered Out then In.'},
        @{name='single channel';pair=@($channels[0]);expected='Exactly one authority pipe pair is required.'},
        @{name='valid pair';pair=@($channels[0],$channels[2]);expected='fixture pre-launch sentinel'},
        @{name='no authority';pair=@();expected='fixture pre-launch sentinel'}
    )
    foreach ($case in $cases) {
        $failure=$null
        try { Invoke-IndependentStopObserver -Request $request -Executable 'fixture' -AuthorityChannels $case.pair -EnableObserver | Out-Null }
        catch { $failure=$_.Exception.Message }
        if ($failure -cne $case.expected) { throw ('Failed '+$case.name+': '+$failure) }
        $checks++
        foreach ($channel in $channels) {
            if ($channel.SafePipeHandle.IsClosed -or $channel.ClientSafePipeHandle.IsClosed) { throw ('Caller-owned pipe closed: '+$case.name) }
        }
        $checks++
    }
} finally { foreach ($channel in $channels) { $channel.Dispose() } }
Write-Output ('Authority channel checks passed: '+$checks)
