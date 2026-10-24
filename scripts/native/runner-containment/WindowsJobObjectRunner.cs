using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;

namespace OverDrafter.NativeContainment
{
    public sealed class RunnerRequest
    {
        public string AttemptId, WorkerId, BootId, RuntimeDigest, JobDigest, Scenario, AttemptRoot;
        public long Fence;
    }
    public sealed class RunnerResult
    {
        public string Operation = "not_started", Persistence = "durable", Cleanup = "not_needed";
        public bool EvidenceEligible, ChildCreated, AssignmentVerified, ChildResumed, JobEmptyProved;
        public int? ExitCode;
        public string FailureCode, JournalPath, JournalDigest;
    }
    /// Source-only closed synthetic backend. No runtime qualification is claimed.
    public sealed class WindowsJobObjectRunner
    {
        private const uint CREATE_SUSPENDED = 0x00000004, CREATE_UNICODE_ENVIRONMENT = 0x00000400;
        private const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000, WAIT_OBJECT_0 = 0, WAIT_TIMEOUT = 0x102;
        private const uint JOB_OBJECT_LIMIT_ACTIVE_PROCESS = 0x8, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
        private const int JobObjectBasicProcessIdList = 3, JobObjectExtendedLimitInformation = 9;
        private const int PROC_THREAD_ATTRIBUTE_JOB_LIST = 0x0002000D, ERROR_MORE_DATA = 234, MaxJobMembers = 16;
        private const int OperationDeadlineMilliseconds = 10000, CleanupBudgetMilliseconds = 5000;
        private const uint ContainmentExitCode = 0xE0000001;
        internal const string JournalGoldenDigest = "e33f359896c8e8cf963c7afda0c4aeff7c374ffe4f5575b064ce255f4443cb03";
        private const string JournalGoldenBody = "{\"attemptId\":\"11111111-1111-7111-8111-111111111111\",\"bootId\":\"boot-1\",\"event\":\"child_resumed\",\"evidence\":{\"resumed\":\"true\"},\"fence\":7,\"jobDigest\":\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\",\"observedUtc\":\"2026-09-12T12:00:00Z\",\"priorDigest\":\"0000000000000000000000000000000000000000000000000000000000000000\",\"runtimeDigest\":\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\",\"schema\":\"overdrafter.native-attempt-journal-record.v1\",\"sequence\":1,\"workerId\":\"worker-1\"}";

        [StructLayout(LayoutKind.Sequential)] private struct IO_COUNTERS
        { public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount; }
        [StructLayout(LayoutKind.Sequential)] private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
        {
            public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; public uint ActiveProcessLimit;
            public UIntPtr Affinity; public uint PriorityClass, SchedulingClass;
        }
        [StructLayout(LayoutKind.Sequential)] private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        {
            public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo;
            public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
        }
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct STARTUPINFO
        {
            public uint cb; public string lpReserved, lpDesktop, lpTitle;
            public uint dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
            public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
        }
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct STARTUPINFOEX
        { public STARTUPINFO StartupInfo; public IntPtr lpAttributeList; }
        [StructLayout(LayoutKind.Sequential)] private struct PROCESS_INFORMATION
        { public IntPtr hProcess, hThread; public uint dwProcessId, dwThreadId; }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, uint length);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool QueryInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length, out uint returnedLength);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool TerminateJobObject(IntPtr job, uint exitCode);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previousValue, IntPtr returnSize);
        [DllImport("kernel32.dll")] private static extern void DeleteProcThreadAttributeList(IntPtr list);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool CreateProcessW(string applicationName, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint creationFlags, IntPtr environment, string currentDirectory, ref STARTUPINFOEX startupInfo, out PROCESS_INFORMATION processInformation);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern uint ResumeThread(IntPtr thread);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool ProcessIdToSessionId(uint processId, out uint sessionId);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, StringBuilder name, ref uint size);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern uint GetWindowsDirectoryW(StringBuilder buffer, uint size);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool CloseHandle(IntPtr handle);
        public RunnerResult Run(RunnerRequest request)
        {
            try { return RunAdmitted(request); }
            catch (JournalException) { return new RunnerResult { Operation = "failed", Persistence = "failed", FailureCode = "journal_persistence_failed" }; }
            catch (RunnerException error) { return new RunnerResult { Operation = "failed", FailureCode = error.Message }; }
            catch { return new RunnerResult { Operation = "failed", FailureCode = "process_uncertain" }; }
        }
        private RunnerResult RunAdmitted(RunnerRequest request)
        {
            request = ValidateRequest(request);
            Check(HashText(JournalGoldenBody) == JournalGoldenDigest, "journal_contract_mismatch");
            string executable = AdmitLocalPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "SyntheticChildTree.exe"), false);
            RunnerResult result = new RunnerResult();
            IntPtr job = IntPtr.Zero, attributeList = IntPtr.Zero, jobValue = IntPtr.Zero, environmentBlock = IntPtr.Zero;
            PROCESS_INFORMATION process = new PROCESS_INFORMATION();
            bool created = false, empty = false, attributeInitialized = false;
            long cleanupDeadline = 0;
            using (FileStream executableHandle = new FileStream(executable, FileMode.Open, FileAccess.Read, FileShare.Read))
            using (EvidenceJournal journal = new EvidenceJournal(request))
            {
                result.JournalPath = journal.Path;
                try
                {
                    string executableDigest = HashStream(executableHandle);
                    job = CreateJobObjectW(IntPtr.Zero, null); Check(job != IntPtr.Zero, "job_create_failed");
                    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
                    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
                    limits.BasicLimitInformation.ActiveProcessLimit = 3;
                    Check(SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref limits,
                        (uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION))), "job_configure_failed");
                    journal.Append("launch_intent", "creationTimeJobAssignment", "true", "executablePath", executable,
                        "executableSha256", executableDigest, "workingDirectory", request.AttemptRoot,
                        "workingDirectorySha256", HashText(request.AttemptRoot));

                    IntPtr attributeBytes = IntPtr.Zero;
                    InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attributeBytes);
                    Check(attributeBytes != IntPtr.Zero, "attribute_size_failed");
                    attributeList = Marshal.AllocHGlobal(attributeBytes);
                    Check(InitializeProcThreadAttributeList(attributeList, 1, 0, ref attributeBytes), "attribute_init_failed");
                    attributeInitialized = true;
                    jobValue = Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(jobValue, job);
                    Check(UpdateProcThreadAttribute(attributeList, 0, new IntPtr(PROC_THREAD_ATTRIBUTE_JOB_LIST),
                        jobValue, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero), "job_attribute_failed");

                    STARTUPINFOEX startup = new STARTUPINFOEX();
                    startup.StartupInfo.cb = (uint)Marshal.SizeOf(typeof(STARTUPINFOEX)); startup.lpAttributeList = attributeList;
                    StringBuilder commandLine = new StringBuilder(Quote(executable) + " " + Quote(request.Scenario) + " " + Quote(request.AttemptRoot));
                    uint flags = CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT;
                    environmentBlock = FixedEnvironment();
                    Check(CreateProcessW(executable, commandLine, IntPtr.Zero, IntPtr.Zero, false, flags,
                        environmentBlock, request.AttemptRoot, ref startup, out process), "process_create_failed");
                    created = result.ChildCreated = true;

                    long creation, exit, kernel, user; uint session; bool inJob;
                    Check(GetProcessTimes(process.hProcess, out creation, out exit, out kernel, out user), "identity_time_failed");
                    Check(ProcessIdToSessionId(process.dwProcessId, out session), "identity_session_failed");
                    Check(IsProcessInJob(process.hProcess, job, out inJob) && inJob, "assignment_unproved");
                    Check(String.Equals(Path.GetFullPath(QueryImagePath(process.hProcess)), executable, StringComparison.OrdinalIgnoreCase), "identity_path_mismatch");
                    int[] members = QueryCompleteMembers(job);
                    Check(Array.IndexOf(members, unchecked((int)process.dwProcessId)) >= 0, "assignment_unproved");
                    journal.Append("child_identity", "creationTicks", creation.ToString(), "executableSha256", executableDigest,
                        "pid", process.dwProcessId.ToString(), "role", "root", "session", session.ToString());
                    journal.Append("assignment_verified", "breakawayAllowed", "false", "memberCount", members.Length.ToString(), "rootPresent", "true");
                    result.AssignmentVerified = true;
                    Check(ResumeThread(process.hThread) == 1, "resume_failed");
                    result.ChildResumed = true; journal.Append("child_resumed", "resumed", "true");

                    uint wait = WaitForSingleObject(process.hProcess, OperationDeadlineMilliseconds);
                    bool terminationRequested = wait == WAIT_TIMEOUT;
                    if (terminationRequested)
                    {
                        result.Operation = "failed"; result.FailureCode = "deadline_exceeded";
                        cleanupDeadline = DeadlineAfter(CleanupBudgetMilliseconds);
                        Check(TerminateJobObject(job, ContainmentExitCode), "job_termination_failed");
                        wait = WaitForSingleObject(process.hProcess, RemainingMilliseconds(cleanupDeadline));
                    }
                    Check(wait == WAIT_OBJECT_0, "process_exit_unproved");
                    uint code; Check(GetExitCodeProcess(process.hProcess, out code), "exit_code_unproved");
                    result.ExitCode = unchecked((int)code);
                    journal.Append("terminal_observed", "creationTicks", creation.ToString(), "exitCode", code.ToString(),
                        "pid", process.dwProcessId.ToString(), "terminationRequested", terminationRequested ? "true" : "false");
                    if (cleanupDeadline == 0) cleanupDeadline = DeadlineAfter(CleanupBudgetMilliseconds);
                    empty = WaitForEmptyJob(job, cleanupDeadline); Check(empty, "job_empty_unproved");
                    result.JobEmptyProved = true; result.Cleanup = terminationRequested ? "proved" : "not_needed";
                    journal.Append("job_empty", "memberCount", "0", "proved", "true");
                    if (!terminationRequested) { result.Operation = code == 0 ? "completed" : "failed"; if (code != 0) result.FailureCode = "child_failed"; }
                    result.JournalDigest = journal.Digest;
                    result.EvidenceEligible = result.Operation == "completed" && result.Persistence == "durable";
                }
                catch (JournalException)
                {
                    result.Persistence = "failed"; result.Operation = "failed"; result.FailureCode = "journal_persistence_failed";
                    EmergencyCleanup(job, process.hProcess, created, result, ref empty, ref cleanupDeadline);
                }
                catch (RunnerException error)
                {
                    result.Operation = "failed"; result.FailureCode = error.Message;
                    EmergencyCleanup(job, process.hProcess, created, result, ref empty, ref cleanupDeadline);
                    TryAppend(journal, result, "failure", "cleanup", result.Cleanup, "code", error.Message, "jobEmpty", empty ? "true" : "false");
                }
                catch
                {
                    result.Operation = "failed"; result.FailureCode = "process_uncertain";
                    EmergencyCleanup(job, process.hProcess, created, result, ref empty, ref cleanupDeadline);
                    TryAppend(journal, result, "failure", "cleanup", result.Cleanup, "code", "process_uncertain", "jobEmpty", empty ? "true" : "false");
                }
                finally
                {
                    result.EvidenceEligible = result.EvidenceEligible && result.Persistence == "durable" && result.JobEmptyProved && result.FailureCode == null;
                    if (process.hThread != IntPtr.Zero) CloseHandle(process.hThread);
                    if (process.hProcess != IntPtr.Zero) CloseHandle(process.hProcess);
                    if (attributeInitialized) DeleteProcThreadAttributeList(attributeList);
                    if (attributeList != IntPtr.Zero) Marshal.FreeHGlobal(attributeList);
                    if (jobValue != IntPtr.Zero) Marshal.FreeHGlobal(jobValue);
                    if (environmentBlock != IntPtr.Zero) Marshal.FreeHGlobal(environmentBlock);
                    if (job != IntPtr.Zero) CloseHandle(job);
                }
            }
            return result;
        }
        private static void EmergencyCleanup(IntPtr job, IntPtr process, bool created, RunnerResult result, ref bool empty, ref long deadline)
        {
            result.EvidenceEligible = false;
            if (!created) { result.Cleanup = "not_needed"; return; }
            if (job == IntPtr.Zero) { result.Cleanup = "unproved"; return; }
            try
            {
                if (deadline == 0) deadline = DeadlineAfter(CleanupBudgetMilliseconds);
                bool terminated = TerminateJobObject(job, ContainmentExitCode);
                bool rootExited = process != IntPtr.Zero && WaitForSingleObject(process, RemainingMilliseconds(deadline)) == WAIT_OBJECT_0;
                empty = terminated && rootExited && WaitForEmptyJob(job, deadline);
                result.JobEmptyProved = empty; result.Cleanup = empty ? "proved" : "unproved";
            }
            catch { empty = false; result.JobEmptyProved = false; result.Cleanup = "unproved"; }
        }

        private static void TryAppend(EvidenceJournal journal, RunnerResult result, string eventName, params string[] fields)
        { try { journal.Append(eventName, fields); result.JournalDigest = journal.Digest; } catch { result.Persistence = "failed"; result.EvidenceEligible = false; } }

        private static int[] QueryCompleteMembers(IntPtr job)
        {
            for (int capacity = 4; capacity <= MaxJobMembers; capacity *= 2)
            {
                int bytes = 8 + capacity * IntPtr.Size; IntPtr buffer = Marshal.AllocHGlobal(bytes);
                try
                {
                    for (int offset = 0; offset < bytes; offset += 4) Marshal.WriteInt32(buffer, offset, 0);
                    uint returned; bool ok = QueryInformationJobObject(job, JobObjectBasicProcessIdList, buffer, (uint)bytes, out returned);
                    uint assigned = unchecked((uint)Marshal.ReadInt32(buffer, 0)), listed = unchecked((uint)Marshal.ReadInt32(buffer, 4));
                    if (!ok && Marshal.GetLastWin32Error() != ERROR_MORE_DATA) throw new RunnerException("membership_query_failed");
                    if (assigned > MaxJobMembers) throw new RunnerException("membership_capacity_exceeded");
                    if (ok && assigned == listed && listed <= capacity)
                    {
                        int[] ids = new int[listed];
                        for (int index = 0; index < listed; index++) ids[index] = IntPtr.Size == 8
                            ? unchecked((int)Marshal.ReadInt64(buffer, 8 + index * 8)) : Marshal.ReadInt32(buffer, 8 + index * 4);
                        return ids;
                    }
                }
                finally { Marshal.FreeHGlobal(buffer); }
            }
            throw new RunnerException("membership_query_truncated");
        }

        private static bool WaitForEmptyJob(IntPtr job, long deadline)
        {
            do { if (QueryCompleteMembers(job).Length == 0) return true; Thread.Sleep(Math.Min(20, (int)RemainingMilliseconds(deadline))); }
            while (RemainingMilliseconds(deadline) > 0);
            return false;
        }
        private static long DeadlineAfter(int milliseconds) { return Stopwatch.GetTimestamp() + (long)(milliseconds * (double)Stopwatch.Frequency / 1000); }
        private static uint RemainingMilliseconds(long deadline)
        {
            long ticks = deadline - Stopwatch.GetTimestamp();
            if (ticks <= 0) return 0;
            return (uint)Math.Min(Int32.MaxValue, Math.Ceiling(ticks * 1000.0 / Stopwatch.Frequency));
        }
        private static string QueryImagePath(IntPtr process)
        {
            StringBuilder path = new StringBuilder(32768); uint length = (uint)path.Capacity;
            Check(QueryFullProcessImageNameW(process, 0, path, ref length), "identity_path_failed"); return path.ToString();
        }
        private static string Quote(string value)
        {
            if (value == null || value.IndexOfAny(new[] { '\0', '\r', '\n' }) >= 0) throw new RunnerException("invalid_argument");
            if (value.Length > 0 && value.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) return value;
            StringBuilder result = new StringBuilder("\""); int slashes = 0;
            foreach (char character in value)
            {
                if (character == '\\') { slashes++; continue; }
                result.Append('\\', character == '"' ? slashes * 2 + 1 : slashes).Append(character); slashes = 0;
            }
            return result.Append('\\', slashes * 2).Append('"').ToString();
        }
        private static RunnerRequest ValidateRequest(RunnerRequest request)
        {
            if (request == null || !System.Text.RegularExpressions.Regex.IsMatch(request.AttemptId ?? "",
                    "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$") || request.Fence < 1
                || !Token(request.WorkerId) || !Token(request.BootId) || !Digest(request.RuntimeDigest) || !Digest(request.JobDigest)
                || Array.IndexOf(new[] { "root-exit", "tree-exit", "tree-timeout", "child-limit" }, request.Scenario) < 0
                || String.IsNullOrWhiteSpace(request.AttemptRoot)) throw new RunnerException("invalid_request");
            RunnerRequest detached = new RunnerRequest { AttemptId = request.AttemptId, Fence = request.Fence,
                WorkerId = request.WorkerId, BootId = request.BootId, RuntimeDigest = request.RuntimeDigest,
                JobDigest = request.JobDigest, Scenario = request.Scenario,
                AttemptRoot = AdmitLocalPath(request.AttemptRoot, true).TrimEnd(Path.DirectorySeparatorChar) };
            if (Directory.GetFileSystemEntries(detached.AttemptRoot).Length != 0) throw new RunnerException("attempt_root_not_fresh");
            return detached;
        }
        private static string AdmitLocalPath(string value, bool directory)
        {
            if (String.IsNullOrWhiteSpace(value) || !System.Text.RegularExpressions.Regex.IsMatch(value, "^[A-Za-z]:[\\\\/]")
                || value.IndexOfAny(new[] { '\0', '\r', '\n' }) >= 0) throw new RunnerException("path_not_local_absolute");
            string full = Path.GetFullPath(value);
            if (new DriveInfo(Path.GetPathRoot(full)).DriveType != DriveType.Fixed) throw new RunnerException("path_not_fixed_drive");
            FileSystemInfo item = directory ? (FileSystemInfo)new DirectoryInfo(full) : new FileInfo(full);
            if (!item.Exists) throw new RunnerException(directory ? "attempt_root_missing" : "synthetic_helper_missing");
            if ((item.Attributes & FileAttributes.ReparsePoint) != 0) throw new RunnerException("path_reparse_forbidden");
            DirectoryInfo cursor = directory ? (DirectoryInfo)item : ((FileInfo)item).Directory;
            while (cursor != null)
            {
                if ((cursor.Attributes & FileAttributes.ReparsePoint) != 0) throw new RunnerException("path_reparse_forbidden");
                cursor = cursor.Parent;
            }
            return full;
        }
        private static IntPtr FixedEnvironment()
        {
            StringBuilder buffer = new StringBuilder(32768); uint length = GetWindowsDirectoryW(buffer, (uint)buffer.Capacity);
            Check(length > 0 && length < buffer.Capacity, "windows_directory_unavailable");
            string windows = AdmitLocalPath(buffer.ToString(), true);
            return Marshal.StringToHGlobalUni("SystemRoot=" + windows + "\0WINDIR=" + windows + "\0");
        }
        private static bool Token(string value) { return !String.IsNullOrEmpty(value) && value.Length <= 64 && System.Text.RegularExpressions.Regex.IsMatch(value, "^[a-z0-9][a-z0-9._-]*$"); }
        private static bool Digest(string value) { return value != null && value.Length == 64 && System.Text.RegularExpressions.Regex.IsMatch(value, "^[0-9a-f]+$"); }
        private static string HashStream(Stream stream)
        { stream.Position = 0; using (SHA256 hash = SHA256.Create()) return Hex(hash.ComputeHash(stream)); }
        internal static string HashText(string value)
        { using (SHA256 hash = SHA256.Create()) return Hex(hash.ComputeHash(new UTF8Encoding(false).GetBytes(value))); }
        private static string Hex(byte[] bytes) { return BitConverter.ToString(bytes).Replace("-", "").ToLowerInvariant(); }
        private static void Check(bool condition, string code) { if (!condition) throw new RunnerException(code); }

        private sealed class RunnerException : Exception { public RunnerException(string message) : base(message) { } }
        private sealed class JournalException : Exception { public JournalException(Exception inner) : base("journal_persistence_failed", inner) { } }

        private sealed class EvidenceJournal : IDisposable
        {
            private const string RecordSchema = "overdrafter.native-attempt-journal-record.v1";
            private readonly RunnerRequest request; private readonly List<string> records = new List<string>();
            private readonly FileStream owner; private string expectedSnapshotHash;
            public readonly string Path; public string Digest { get; private set; } = new string('0', 64);
            public EvidenceJournal(RunnerRequest value)
            {
                try
                {
                    request = value; Path = System.IO.Path.Combine(value.AttemptRoot, "attempt-journal.json");
                    if (File.Exists(Path)) throw new IOException("journal_exists");
                    owner = new FileStream(System.IO.Path.Combine(value.AttemptRoot, "owner.lock"), FileMode.CreateNew,
                        FileAccess.ReadWrite, FileShare.None, 1, FileOptions.WriteThrough);
                }
                catch (Exception error) { throw new JournalException(error); }
            }
            public void Dispose() { owner.Dispose(); }
            public void Append(string eventName, params string[] fields)
            {
                try
                {
                    if (fields.Length == 0 || fields.Length > 16 || fields.Length % 2 != 0) throw new InvalidOperationException("invalid_evidence");
                    SortedDictionary<string, string> evidence = new SortedDictionary<string, string>(StringComparer.Ordinal);
                    for (int index = 0; index < fields.Length; index += 2)
                    {
                        if (fields[index] == null || fields[index + 1] == null || Encoding.UTF8.GetByteCount(fields[index + 1]) > 512
                            || evidence.ContainsKey(fields[index])) throw new InvalidOperationException("invalid_evidence");
                        evidence.Add(fields[index], fields[index + 1]);
                    }
                    string body = CanonicalBody(records.Count + 1, Digest, eventName, DateTime.UtcNow.ToString("o"), evidence);
                    string digest = HashText(body), record = body.Substring(0, body.Length - 1) + ",\"digest\":" + Json(digest) + "}";
                    string previousDigest = Digest; records.Add(record); Digest = digest;
                    try { Persist(); } catch { records.RemoveAt(records.Count - 1); Digest = previousDigest; throw; }
                }
                catch (JournalException) { throw; }
                catch (Exception error) { throw new JournalException(error); }
            }
            private string CanonicalBody(int sequence, string priorDigest, string eventName, string observedUtc, SortedDictionary<string, string> evidence)
            {
                StringBuilder e = new StringBuilder("{");
                foreach (KeyValuePair<string, string> item in evidence) { if (e.Length > 1) e.Append(','); e.Append(Json(item.Key)).Append(':').Append(Json(item.Value)); }
                e.Append('}');
                return "{\"attemptId\":" + Json(request.AttemptId) + ",\"bootId\":" + Json(request.BootId)
                    + ",\"event\":" + Json(eventName) + ",\"evidence\":" + e + ",\"fence\":" + request.Fence
                    + ",\"jobDigest\":" + Json(request.JobDigest) + ",\"observedUtc\":" + Json(observedUtc)
                    + ",\"priorDigest\":" + Json(priorDigest) + ",\"runtimeDigest\":" + Json(request.RuntimeDigest)
                    + ",\"schema\":" + Json(RecordSchema) + ",\"sequence\":" + sequence + ",\"workerId\":" + Json(request.WorkerId) + "}";
            }
            private void Persist()
            {
                string temporary = Path + "." + Guid.NewGuid().ToString("N") + ".tmp";
                try
                {
                    if (expectedSnapshotHash == null) { if (File.Exists(Path)) throw new IOException("journal_collision"); }
                    else if (!File.Exists(Path) || HashFile(Path) != expectedSnapshotHash) throw new IOException("journal_changed");
                    string document = "{\"schema\":\"overdrafter.native-attempt-journal.v1\",\"records\":[" + String.Join(",", records.ToArray()) + "]}";
                    byte[] bytes = new UTF8Encoding(false).GetBytes(document); if (bytes.Length > 65536) throw new IOException("journal_limit");
                    using (FileStream file = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough))
                    { file.Write(bytes, 0, bytes.Length); file.Flush(true); }
                    if (expectedSnapshotHash == null) File.Move(temporary, Path); else File.Replace(temporary, Path, null);
                    expectedSnapshotHash = HashFile(Path);
                }
                catch (Exception error) { try { if (File.Exists(temporary)) File.Delete(temporary); } catch { } throw new JournalException(error); }
            }
            private static string HashFile(string path)
            { using (FileStream file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read)) return HashStream(file); }
            private static string Json(string value)
            {
                StringBuilder result = new StringBuilder("\"");
                foreach (char c in value)
                {
                    if (c == '\\' || c == '"') result.Append('\\').Append(c); else if (c == '\r') result.Append("\\r");
                    else if (c == '\n') result.Append("\\n"); else if (c == '\t') result.Append("\\t");
                    else if (c < 0x20) result.Append("\\u").Append(((int)c).ToString("x4")); else result.Append(c);
                }
                return result.Append('"').ToString();
            }
        }
    }
}
