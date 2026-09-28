#requires -Version 5.1
# Two directly inherited, ACL-at-creation anonymous pipes. Only the companion
# owns the network credential. Frames are UTF-8 with a four-byte length prefix.
Set-StrictMode -Version Latest
function New-CompanionAuthorityPipe($Sid) {
    $acl=[IO.Pipes.PipeSecurity]::new()
    $acl.SetOwner($Sid); $acl.SetAccessRuleProtection($true,$false)
    $acl.AddAccessRule([IO.Pipes.PipeAccessRule]::new($Sid,[IO.Pipes.PipeAccessRights]::ReadWrite,
        [Security.AccessControl.AccessControlType]::Allow))
    $toRunner=[IO.Pipes.AnonymousPipeServerStream]::new([IO.Pipes.PipeDirection]::Out,
        [IO.HandleInheritability]::Inheritable,4096,$acl)
    try {
        $fromRunner=[IO.Pipes.AnonymousPipeServerStream]::new([IO.Pipes.PipeDirection]::In,
            [IO.HandleInheritability]::Inheritable,4096,$acl)
        return [pscustomobject]@{incoming=$fromRunner;outgoing=$toRunner;
            readHandle=$toRunner.GetClientHandleAsString();writeHandle=$fromRunner.GetClientHandleAsString()}
    } catch { $toRunner.Dispose(); throw }
}
function Open-RunnerAuthorityPipe([string]$ReadHandle,[string]$WriteHandle) {
    if ($ReadHandle -cnotmatch '^[0-9]+$' -or $WriteHandle -cnotmatch '^[0-9]+$') {
        throw 'Runner authority handles are invalid.'
    }
    $incoming=[IO.Pipes.AnonymousPipeClientStream]::new([IO.Pipes.PipeDirection]::In,$ReadHandle)
    try {
        $outgoing=[IO.Pipes.AnonymousPipeClientStream]::new([IO.Pipes.PipeDirection]::Out,$WriteHandle)
        # The runner later starts the operation helper with redirected stdio.
        # Its authority handles must not be inherited by that grandchild; EOF
        # on companion/runner loss must still deny every pending effect.
        $interop='OverDrafter.AuthorityPipeInheritance' -as [type]
        if ($null -eq $interop) {
            # Fixed P/Invoke without an unjournaled compiler inside the root job.
            $name=New-Object Reflection.AssemblyName('OverDrafter.AuthorityPipeInheritance')
            $assembly=[AppDomain]::CurrentDomain.DefineDynamicAssembly($name,[Reflection.Emit.AssemblyBuilderAccess]::Run)
            $module=$assembly.DefineDynamicModule($name.Name)
            $builder=$module.DefineType($name.Name,[Reflection.TypeAttributes]'Public,Sealed,Abstract')
            $method=$builder.DefinePInvokeMethod('SetHandleInformation','kernel32.dll',
                [Reflection.MethodAttributes]'Public,Static,PinvokeImpl',[Reflection.CallingConventions]::Standard,
                [bool],[type[]]@([IntPtr],[uint32],[uint32]),
                [Runtime.InteropServices.CallingConvention]::Winapi,[Runtime.InteropServices.CharSet]::Unicode)
            $method.SetImplementationFlags($method.GetMethodImplementationFlags() -bor [Reflection.MethodImplAttributes]::PreserveSig)
            $interop=$builder.CreateType()
        }
        if (-not [OverDrafter.AuthorityPipeInheritance]::SetHandleInformation($incoming.SafePipeHandle.DangerousGetHandle(),1,0) -or
            -not [OverDrafter.AuthorityPipeInheritance]::SetHandleInformation($outgoing.SafePipeHandle.DangerousGetHandle(),1,0)) {
            throw 'Runner authority handles remain inheritable.'
        }
        return [pscustomobject]@{incoming=$incoming;outgoing=$outgoing}
    } catch { $incoming.Dispose(); if ($null -ne $outgoing) { $outgoing.Dispose() }; throw }
}
function Close-CompanionAuthorityPipe($Channel) {
    if ($null -eq $Channel) { return }
    if ($null -ne $Channel.incoming) { $Channel.incoming.Dispose() }
    if ($null -ne $Channel.outgoing) { $Channel.outgoing.Dispose() }
}
function Send-CompanionAuthorityFrame($Stream,[string]$Text,[int]$TimeoutMs=5000) {
    $bytes=(New-Object Text.UTF8Encoding($false,$true)).GetBytes($Text)
    if ($bytes.Length -lt 1 -or $bytes.Length -gt 4096 -or $TimeoutMs -lt 1) { throw 'Authority frame exceeds bound.' }
    $size=[BitConverter]::GetBytes([int]$bytes.Length)
    if (-not [BitConverter]::IsLittleEndian) { [Array]::Reverse($size) }
    $frame=New-Object byte[] (4+$bytes.Length)
    [Array]::Copy($size,0,$frame,0,4); [Array]::Copy($bytes,0,$frame,4,$bytes.Length)
    $timer=[Diagnostics.Stopwatch]::StartNew()
    $write=$Stream.WriteAsync($frame,0,$frame.Length)
    if (-not $write.Wait($TimeoutMs)) { throw 'Authority frame write timed out.' }
    $remaining=$TimeoutMs-[int]$timer.ElapsedMilliseconds
    if ($remaining -lt 1) { throw 'Authority frame flush timed out.' }
    $flush=$Stream.FlushAsync()
    if (-not $flush.Wait($remaining)) { throw 'Authority frame flush timed out.' }
}
function Read-CompanionAuthorityBytes($Stream,[byte[]]$Buffer,[int]$TimeoutMs) {
    $timer=[Diagnostics.Stopwatch]::StartNew(); $offset=0
    while ($offset -lt $Buffer.Length) {
        $remaining=$TimeoutMs-[int]$timer.ElapsedMilliseconds
        if ($remaining -lt 1) { throw 'Authority frame read timed out.' }
        $read=$Stream.ReadAsync($Buffer,$offset,$Buffer.Length-$offset)
        if (-not $read.Wait($remaining)) { throw 'Authority frame read timed out.' }
        $count=$read.GetAwaiter().GetResult()
        if ($count -lt 1) { throw 'Authority pipe closed.' }
        $offset+=$count
    }
}
function Receive-CompanionAuthorityFrame($Stream,[int]$TimeoutMs=30000) {
    if ($TimeoutMs -lt 1 -or $TimeoutMs -gt 30000) { throw 'Authority read bound is invalid.' }
    $timer=[Diagnostics.Stopwatch]::StartNew(); $header=New-Object byte[] 4
    Read-CompanionAuthorityBytes $Stream $header $TimeoutMs
    if (-not [BitConverter]::IsLittleEndian) { [Array]::Reverse($header) }
    $size=[BitConverter]::ToInt32($header,0)
    if ($size -lt 1 -or $size -gt 4096) { throw 'Authority frame length is invalid.' }
    $remaining=$TimeoutMs-[int]$timer.ElapsedMilliseconds
    if ($remaining -lt 1) { throw 'Authority frame read timed out.' }
    $body=New-Object byte[] $size
    Read-CompanionAuthorityBytes $Stream $body $remaining
    return (New-Object Text.UTF8Encoding($false,$true)).GetString($body)
}
# The companion polls this state while it also renews the exact attempt. A
# pending read never blocks heartbeat, and oversized frames are denied at the
# header before allocation.
function New-CompanionAuthorityRead($Stream) {
    $buffer=New-Object byte[] 4
    return [pscustomobject]@{stream=$Stream;buffer=$buffer;offset=0;
        task=$Stream.ReadAsync($buffer,0,4);header=$true;closed=$false}
}
function Receive-CompanionAuthorityPoll($State) {
    if ($State.closed) { return $null }
    while ($State.task.IsCompleted) {
        $count=$State.task.GetAwaiter().GetResult()
        if ($count -lt 1) {
            if ($State.header -and $State.offset -eq 0) { $State.closed=$true; return $null }
            throw 'Runner authority pipe closed during a frame.'
        }
        $State.offset+=$count
        if ($State.offset -lt $State.buffer.Length) {
            $State.task=$State.stream.ReadAsync($State.buffer,$State.offset,$State.buffer.Length-$State.offset)
            continue
        }
        if ($State.header) {
            $header=$State.buffer
            if (-not [BitConverter]::IsLittleEndian) { [Array]::Reverse($header) }
            $size=[BitConverter]::ToInt32($header,0)
            if ($size -lt 1 -or $size -gt 4096) { throw 'Runner authority frame length is invalid.' }
            $State.buffer=New-Object byte[] $size; $State.offset=0; $State.header=$false
            $State.task=$State.stream.ReadAsync($State.buffer,0,$size)
            continue
        }
        $text=(New-Object Text.UTF8Encoding($false,$true)).GetString($State.buffer)
        $State.buffer=New-Object byte[] 4; $State.offset=0; $State.header=$true
        $State.task=$State.stream.ReadAsync($State.buffer,0,4)
        return $text
    }
    return $null
}
