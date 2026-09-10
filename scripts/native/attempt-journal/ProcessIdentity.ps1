#requires -Version 5.1
# Query the retained kernel process object, not a live module/PID inventory.
# Reflection.Emit declares fixed P/Invokes without launching a C# compiler.
function Get-JournalProcessQueries {
    Assert-CompanionWindows
    $existing='OverDrafter.JournalProcessQueriesV1' -as [type]
    if ($null -ne $existing) { return $existing }
    $name=New-Object Reflection.AssemblyName('OverDrafter.JournalProcessQueriesV1')
    $assembly=[AppDomain]::CurrentDomain.DefineDynamicAssembly($name,[Reflection.Emit.AssemblyBuilderAccess]::Run)
    $module=$assembly.DefineDynamicModule($name.Name)
    $builder=$module.DefineType($name.Name,[Reflection.TypeAttributes]'Public,Sealed,Abstract')
    $methods=@(
        @{name='GetProcessId';dll='kernel32.dll';result=[uint32];args=[type[]]@([IntPtr])},
        @{name='GetProcessTimes';dll='kernel32.dll';result=[bool];args=[type[]]@([IntPtr],[long].MakeByRefType(),[long].MakeByRefType(),[long].MakeByRefType(),[long].MakeByRefType())},
        @{name='QueryFullProcessImageNameW';dll='kernel32.dll';result=[bool];args=[type[]]@([IntPtr],[uint32],[Text.StringBuilder],[uint32].MakeByRefType())},
        @{name='OpenProcessToken';dll='advapi32.dll';result=[bool];args=[type[]]@([IntPtr],[uint32],[IntPtr].MakeByRefType())},
        @{name='GetTokenInformation';dll='advapi32.dll';result=[bool];args=[type[]]@([IntPtr],[int],[int].MakeByRefType(),[int],[int].MakeByRefType())},
        @{name='CloseHandle';dll='kernel32.dll';result=[bool];args=[type[]]@([IntPtr])}
    )
    foreach ($definition in $methods) {
        $method=$builder.DefinePInvokeMethod($definition.name,$definition.dll,
            [Reflection.MethodAttributes]'Public,Static,PinvokeImpl',[Reflection.CallingConventions]::Standard,
            $definition.result,$definition.args,[Runtime.InteropServices.CallingConvention]::Winapi,[Runtime.InteropServices.CharSet]::Unicode)
        $method.SetImplementationFlags($method.GetMethodImplementationFlags() -bor [Reflection.MethodImplAttributes]::PreserveSig)
    }
    return $builder.CreateType()
}
# GetProcessTimes and image/token queries bind to the retained process handle,
# including after an observed fast exit. No process is reopened by PID. Failures
# remain gaps; the qualified Windows fast-exit case must prove this runtime.
function Get-RunnerProcessIdentity($Process) {
    $query=Get-JournalProcessQueries
    $handle=$Process.Handle
    $processId=$query::GetProcessId($handle)
    if ($processId -eq 0 -or $processId -gt 2147483647) { throw 'Retained process identity query failed.' }
    $creation=0L; $exitTime=0L; $kernelTime=0L; $userTime=0L
    if (-not $query::GetProcessTimes($handle,[ref]$creation,[ref]$exitTime,[ref]$kernelTime,[ref]$userTime)) { throw 'Retained process creation query failed.' }
    $path=New-Object Text.StringBuilder(261); $size=[uint32]261
    if (-not $query::QueryFullProcessImageNameW($handle,0,$path,[ref]$size) -or $size -eq 0 -or $size -gt 260) { throw 'Retained process image query failed.' }
    $token=[IntPtr]::Zero
    if (-not $query::OpenProcessToken($handle,8,[ref]$token)) { throw 'Retained process token query failed.' }
    try {
        $sessionId=0; $length=0
        # TOKEN_QUERY=8; TokenSessionId=12 returns one DWORD (four bytes).
        if (-not $query::GetTokenInformation($token,12,[ref]$sessionId,4,[ref]$length) -or $length -ne 4 -or $sessionId -lt 0) { throw 'Retained process session query failed.' }
        return [pscustomobject]@{pid=[int]$processId;creationTicks=[DateTime]::FromFileTimeUtc($creation).Ticks.ToString();
            sessionId=$sessionId;executablePath=$path.ToString()}
    } finally { if (-not $query::CloseHandle($token)) { throw 'Retained process query token could not be closed.' } }
}
