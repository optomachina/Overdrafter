using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace OverDrafter.StopObserver {
    // Fixed detached-console launcher. Only explicit standard/authority pipe
    // handles inherit. The caller retains this kernel identity through exit.
    public sealed class DetachedProcess : IDisposable {
        [StructLayout(LayoutKind.Sequential)] private struct Security {
            public int length; public IntPtr descriptor; public int inherit;
        }
        [StructLayout(LayoutKind.Sequential)] private struct Startup {
            public int cb; public IntPtr reserved, desktop, title;
            public int x, y, xSize, ySize, xChars, yChars, fill, flags;
            public short show, reservedSize; public IntPtr reserved2, input, output, error;
        }
        [StructLayout(LayoutKind.Sequential)] private struct ExtendedStartup { public Startup startup; public IntPtr attributes; }
        [StructLayout(LayoutKind.Sequential)] private struct ProcessInfo { public IntPtr process, thread; public int pid, tid; }
        [DllImport("kernel32.dll", SetLastError=true)] private static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref Security attributes, int size);
        [DllImport("kernel32.dll", SetLastError=true)] private static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
        [DllImport("kernel32.dll", SetLastError=true)] private static extern uint GetFileType(IntPtr handle);
        [DllImport("kernel32.dll", SetLastError=true)] private static extern bool GetHandleInformation(IntPtr handle, out uint flags);
        [DllImport("kernel32.dll", SetLastError=true)] private static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
        [DllImport("kernel32.dll", SetLastError=true)] private static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
        [DllImport("kernel32.dll")] private static extern void DeleteProcThreadAttributeList(IntPtr list);
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
        private static extern bool CreateProcessW(string application, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes,
            bool inherit, uint flags, IntPtr environment, string directory, ref ExtendedStartup startup, out ProcessInfo info);
        [DllImport("kernel32.dll", SetLastError=true)] private static extern uint ResumeThread(IntPtr thread);
        [DllImport("kernel32.dll", SetLastError=true)] private static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll", SetLastError=true)] private static extern bool TerminateProcess(IntPtr process, uint code);
        [DllImport("kernel32.dll", SetLastError=true)] private static extern uint WaitForSingleObject(IntPtr process, uint timeout);
        [DllImport("kernel32.dll", SetLastError=true)] private static extern bool GetExitCodeProcess(IntPtr process, out uint code);
        [DllImport("user32.dll", SetLastError=true)] private static extern uint WaitForInputIdle(IntPtr process, uint timeout);
        private IntPtr handle, thread;
        private bool resumed, disposed;
        public int Id { get; private set; }
        public IntPtr Handle { get { if (handle == IntPtr.Zero) throw new InvalidOperationException("Process handle unavailable."); return handle; } }
        public ProcessStartInfo StartInfo { get; private set; }
        public StreamReader StandardOutput { get; private set; }
        public StreamReader StandardError { get; private set; }
        public StreamWriter StandardInput { get; private set; }
        public DetachedProcess() { StartInfo=new ProcessStartInfo(); }
        private static void Require(bool value) { if (!value) throw new Win32Exception(Marshal.GetLastWin32Error()); }
        private static void Close(ref IntPtr value) { if (value != IntPtr.Zero) { CloseHandle(value); value=IntPtr.Zero; } }
        private static void Pipe(out IntPtr read, out IntPtr write, bool parentReads) {
            var security=new Security { length=Marshal.SizeOf(typeof(Security)), inherit=1 };
            Require(CreatePipe(out read,out write,ref security,0));
            try { Require(SetHandleInformation(parentReads ? read : write,1,0)); }
            catch { Close(ref read); Close(ref write); throw; }
        }
        private static IntPtr Attributes(IntPtr[] handles, out IntPtr values) {
            values=IntPtr.Zero;
            IntPtr size=IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero,1,0,ref size);
            if (size == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
            IntPtr list=Marshal.AllocHGlobal(size); bool initialized=false;
            try {
                Require(InitializeProcThreadAttributeList(list,1,0,ref size)); initialized=true;
                values=Marshal.AllocHGlobal(IntPtr.Size*handles.Length);
                try {
                    for (int i=0;i<handles.Length;i++) {
                        uint flags; Require(GetHandleInformation(handles[i],out flags));
                        if ((flags & 1) != 1) throw new InvalidOperationException("Explicit inherited handle is not inheritable.");
                        Marshal.WriteIntPtr(values,i*IntPtr.Size,handles[i]);
                    }
                    Require(UpdateProcThreadAttribute(list,0,new IntPtr(0x20002),values,new IntPtr(IntPtr.Size*handles.Length),IntPtr.Zero,IntPtr.Zero));
                    // The attribute API retains the caller's handle-array memory
                    // until process creation; ownership transfers with this pair.
                    return list;
                } catch { Marshal.FreeHGlobal(values); values=IntPtr.Zero; throw; }
            } catch { if (initialized) DeleteProcThreadAttributeList(list); Marshal.FreeHGlobal(list); throw; }
        }
        private static void FreeAttributes(IntPtr list, IntPtr values) {
            if (list == IntPtr.Zero) return;
            DeleteProcThreadAttributeList(list); Marshal.FreeHGlobal(values); Marshal.FreeHGlobal(list);
        }
        // Caller owns suspension. Root must be assigned to its private job and
        // identity-checked before Resume. No callback is invoked while suspended.
        public static DetachedProcess CreateSuspended(string executable, string commandLine, string directory, IntPtr[] inherited) {
            if (string.IsNullOrEmpty(executable) || !Path.IsPathRooted(executable) || commandLine == null || commandLine.Length > 30000 || inherited == null || (inherited.Length != 0 && inherited.Length != 2))
                throw new ArgumentException("Detached launch input outside bound.");
            var value=new DetachedProcess();
            IntPtr inputRead=IntPtr.Zero,inputWrite=IntPtr.Zero,outputRead=IntPtr.Zero,outputWrite=IntPtr.Zero,errorRead=IntPtr.Zero,errorWrite=IntPtr.Zero,list=IntPtr.Zero,attributeMemory=IntPtr.Zero;
            try {
                Pipe(out inputRead,out inputWrite,false); Pipe(out outputRead,out outputWrite,true); Pipe(out errorRead,out errorWrite,true);
                var handles=new List<IntPtr> { inputRead,outputWrite,errorWrite };
                foreach (IntPtr extra in inherited) {
                    if (extra == IntPtr.Zero || handles.Contains(extra) || GetFileType(extra) != 3) throw new ArgumentException("Authority inheritance requires two distinct pipe handles.");
                    handles.Add(extra);
                }
                list=Attributes(handles.ToArray(),out attributeMemory);
                var startup=new ExtendedStartup(); startup.startup.cb=Marshal.SizeOf(typeof(ExtendedStartup));
                startup.startup.flags=0x100; startup.startup.input=inputRead; startup.startup.output=outputWrite; startup.startup.error=errorWrite; startup.attributes=list;
                ProcessInfo info;
                Require(CreateProcessW(executable,new StringBuilder(commandLine),IntPtr.Zero,IntPtr.Zero,true,0x0008000c,
                    IntPtr.Zero,directory,ref startup,out info)); // EXTENDED_STARTUPINFO | DETACHED | SUSPENDED
                value.handle=info.process; value.thread=info.thread; value.Id=info.pid;
                value.StandardInput=new StreamWriter(new FileStream(new SafeFileHandle(inputWrite,true),FileAccess.Write),new UTF8Encoding(false)); inputWrite=IntPtr.Zero;
                value.StandardInput.AutoFlush=true;
                value.StandardOutput=new StreamReader(new FileStream(new SafeFileHandle(outputRead,true),FileAccess.Read),Encoding.UTF8); outputRead=IntPtr.Zero;
                value.StandardError=new StreamReader(new FileStream(new SafeFileHandle(errorRead,true),FileAccess.Read),Encoding.UTF8); errorRead=IntPtr.Zero;
                return value;
            } catch { if (value.handle != IntPtr.Zero) TerminateProcess(value.handle,1); value.Dispose(); throw; }
            finally { FreeAttributes(list,attributeMemory); Close(ref inputRead); Close(ref inputWrite); Close(ref outputRead); Close(ref outputWrite); Close(ref errorRead); Close(ref errorWrite); }
        }
        public void Resume() {
            if (disposed || resumed || thread == IntPtr.Zero) throw new InvalidOperationException("Detached process cannot resume.");
            if (ResumeThread(thread) != 1) throw new InvalidOperationException("Detached process suspension differs.");
            resumed=true; Require(CloseHandle(thread)); thread=IntPtr.Zero;
        }
        // Existing OwnedProcess capture callbacks execute only after Start returns;
        // preserve that ordering for callbacks that synchronously relay effects.
        public bool Start() {
            if (handle != IntPtr.Zero || disposed || StartInfo.UseShellExecute || !StartInfo.RedirectStandardOutput || !StartInfo.RedirectStandardError)
                throw new InvalidOperationException("Unsupported detached process settings.");
            string directory=StartInfo.WorkingDirectory; if (string.IsNullOrEmpty(directory)) directory=Environment.CurrentDirectory;
            var created=CreateSuspended(StartInfo.FileName,"\""+StartInfo.FileName+"\" "+StartInfo.Arguments,directory,new IntPtr[0]);
            handle=created.handle; thread=created.thread; Id=created.Id; StandardInput=created.StandardInput; StandardOutput=created.StandardOutput; StandardError=created.StandardError;
            created.handle=IntPtr.Zero; created.thread=IntPtr.Zero;
            try { Resume(); if (!StartInfo.RedirectStandardInput) StandardInput.Close(); return true; }
            catch { try { if (!HasExited) Kill(); } finally { Dispose(); }; throw; }
        }
        // GUI readiness is queried against the retained kernel identity.
        public bool WaitForInputIdle(int milliseconds) {
            if (milliseconds < 1 || milliseconds > 600000) throw new ArgumentOutOfRangeException("milliseconds");
            uint result=WaitForInputIdle(Handle,(uint)milliseconds);
            if (result == 0) return true; if (result == 258) return false;
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        public bool HasExited { get { return WaitForExit(0); } }
        public bool WaitForExit(int milliseconds) {
            if (milliseconds < 0 || milliseconds > 600000) throw new ArgumentOutOfRangeException("milliseconds");
            uint result=WaitForSingleObject(Handle,(uint)milliseconds);
            if (result == 0) return true; if (result == 258) return false;
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        public int ExitCode { get { if (!HasExited) throw new InvalidOperationException("No retained exit."); uint code; Require(GetExitCodeProcess(Handle,out code)); return unchecked((int)code); } }
        public void Kill() { Require(TerminateProcess(Handle,1)); }
        public void Dispose() {
            if (disposed) return; disposed=true;
            // Never leave a created-but-unresumed child orphaned on setup failure.
            if (!resumed && handle != IntPtr.Zero) TerminateProcess(handle,1);
            try { if (StandardInput != null) StandardInput.Dispose(); }
            finally {
                try { if (StandardOutput != null) StandardOutput.Dispose(); }
                finally {
                    try { if (StandardError != null) StandardError.Dispose(); }
                    finally { Close(ref thread); Close(ref handle); }
                }
            }
        }
    }
}
