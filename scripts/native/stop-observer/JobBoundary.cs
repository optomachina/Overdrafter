using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

namespace OverDrafter.StopObserver {
    // Private, non-inherited job. No network, CAD, registry or admission API.
    public sealed class JobBoundary : IDisposable {
        private IntPtr job;
        private DetachedProcess root;
        public IntPtr RootHandle { get { return root == null ? IntPtr.Zero : root.Handle; } }
        public DetachedProcess RootProcess { get { return root; } }
        public int RootPid { get; private set; }
        // Diagnostic metadata only; never included in the authoritative manifest.
        public string LaunchCommandLine { get; private set; }
        private bool resumed;
        private bool disposed;
        public sealed class Counts { public uint Total; public uint Active; public uint Limited; }
        [StructLayout(LayoutKind.Sequential)] private struct Accounting {
            public long user, kernel, periodUser, periodKernel;
            public uint faults, total, active, terminated;
        }
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
        private static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
        [DllImport("kernel32.dll", SetLastError=true)] private static extern bool SetInformationJobObject(IntPtr job, int kind, IntPtr data, uint size);
        [DllImport("kernel32.dll", SetLastError=true)] private static extern bool QueryInformationJobObject(IntPtr job, int kind, IntPtr data, uint size, out uint length);
        [DllImport("kernel32.dll", SetLastError=true)] private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
        [DllImport("kernel32.dll", SetLastError=true)] private static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
        [DllImport("kernel32.dll", SetLastError=true)] private static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
        [DllImport("kernel32.dll", SetLastError=true)] private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
        [DllImport("kernel32.dll", SetLastError=true)] private static extern bool GetExitCodeProcess(IntPtr handle, out uint code);
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
        private static extern bool QueryFullProcessImageNameW(IntPtr handle, uint flags, StringBuilder name, ref uint size);
        [DllImport("kernel32.dll", SetLastError=true)] private static extern bool TerminateProcess(IntPtr process, uint code);
        [DllImport("kernel32.dll", SetLastError=true)] private static extern bool CloseHandle(IntPtr handle);
        private static void Require(bool value) { if (!value) throw new Win32Exception(Marshal.GetLastWin32Error()); }
        private void Live() { if (disposed || job == IntPtr.Zero) throw new InvalidOperationException("Observer job unavailable."); }

        // Construct before executing a single root instruction. Failure never returns a usable observer.
        public JobBoundary(string executable, string commandLine, string directory) : this(executable,commandLine,directory,new IntPtr[0]) {}
        public JobBoundary(string executable, string commandLine, string directory, IntPtr[] authorityPipes) {
            LaunchCommandLine=commandLine;
            try {
                job=CreateJobObjectW(IntPtr.Zero, null); Require(job != IntPtr.Zero);
                // JOBOBJECT_EXTENDED_LIMIT_INFORMATION: LimitFlags offset 16 on x86/x64.
                int size=IntPtr.Size == 8 ? 144 : 112;
                IntPtr limits=Marshal.AllocHGlobal(size);
                try {
                    Marshal.Copy(new byte[size], 0, limits, size);
                    Marshal.WriteInt32(limits,16,0x2000); // KILL_ON_JOB_CLOSE; neither breakaway flag.
                    Require(SetInformationJobObject(job,9,limits,(uint)size));
                } finally { Marshal.FreeHGlobal(limits); }
                root=DetachedProcess.CreateSuspended(executable,commandLine,directory,authorityPipes);
                RootPid=root.Id;
                Require(AssignProcessToJobObject(job,RootHandle)); RequireMember(RootHandle);
                var counts=ReadCounts();
                if (counts.Total != 1 || counts.Active != 1 || counts.Limited != 0) throw new InvalidOperationException("Initial job differs.");
            } catch {
                // An assignment failure leaves only our suspended, never-executed root.
                if (RootHandle != IntPtr.Zero) TerminateProcess(RootHandle,1);
                Dispose(); throw;
            }
        }
        public void Resume() {
            Live(); if (resumed) throw new InvalidOperationException("Root already resumed.");
            RequireMember(RootHandle);
            root.Resume(); resumed=true;
        }
        public void RequireMember(IntPtr process) {
            Live(); bool member; Require(IsProcessInJob(process,job,out member));
            if (!member) throw new InvalidOperationException("Process outside observer job.");
        }
        public Counts ReadCounts() {
            Live(); int size=Marshal.SizeOf(typeof(Accounting)); IntPtr data=Marshal.AllocHGlobal(size);
            try {
                uint length; Require(QueryInformationJobObject(job,1,data,(uint)size,out length));
                if (length != size) throw new InvalidOperationException("Accounting length differs.");
                var value=(Accounting)Marshal.PtrToStructure(data,typeof(Accounting));
                return new Counts { Total=value.total, Active=value.active, Limited=value.terminated };
            } finally { Marshal.FreeHGlobal(data); }
        }
        // A truncated or racing oversized list is failure, never an empty observation.
        public int[] ReadPids() {
            Live(); const int maximum=129; int size=8+maximum*IntPtr.Size;
            IntPtr data=Marshal.AllocHGlobal(size);
            try {
                uint length; Require(QueryInformationJobObject(job,3,data,(uint)size,out length));
                uint assigned=unchecked((uint)Marshal.ReadInt32(data)), count=unchecked((uint)Marshal.ReadInt32(data,4));
                if (assigned > maximum || count > maximum || count != assigned) throw new InvalidOperationException("Process list incomplete.");
                var result=new List<int>();
                for (int i=0;i<count;i++) {
                    long pid=Marshal.ReadIntPtr(data,8+i*IntPtr.Size).ToInt64();
                    if (pid < 1 || pid > int.MaxValue) throw new InvalidOperationException("Process ID outside bound.");
                    result.Add((int)pid);
                }
                return result.ToArray();
            } finally { Marshal.FreeHGlobal(data); }
        }
        public IntPtr OpenMember(int pid) {
            Live(); IntPtr handle=OpenProcess(0x00101000,false,pid); // SYNCHRONIZE | QUERY_LIMITED_INFORMATION
            Require(handle != IntPtr.Zero);
            try { RequireMember(handle); return handle; } catch { CloseHandle(handle); throw; }
        }
        public static string Image(IntPtr handle) {
            var value=new StringBuilder(1024); uint size=1024;
            Require(QueryFullProcessImageNameW(handle,0,value,ref size));
            if (size == 0 || size >= 1024) throw new InvalidOperationException("Image identity unavailable.");
            return value.ToString();
        }
        public static bool Exited(IntPtr handle) {
            uint wait=WaitForSingleObject(handle,0);
            if (wait == 0) return true;
            if (wait == 258) return false;
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        public static int ExitCode(IntPtr handle) {
            if (!Exited(handle)) throw new InvalidOperationException("Terminal observation missing.");
            uint code; Require(GetExitCodeProcess(handle,out code)); return unchecked((int)code);
        }
        public void Release(IntPtr handle) {
            if (RootHandle == handle) { root.Dispose(); root=null; }
            else Require(CloseHandle(handle));
        }
        public void Dispose() {
            if (disposed) return; disposed=true;
            if (job != IntPtr.Zero) { CloseHandle(job); job=IntPtr.Zero; }
            if (root != null) { root.Dispose(); root=null; }
        }
    }
}
