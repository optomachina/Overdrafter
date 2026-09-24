using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

// The fixed synthetic package's Windows admission writer. PowerShell retains this
// object, and therefore its handles, through the native attempt. No report field
// or caller-supplied path string can mint these identities.
public sealed class PreparedFilesystemAdmission : IDisposable
{
    private const uint ReadAttributes = 0x80;
    // FILE_READ_DATA and FILE_LIST_DIRECTORY share this access bit. Requesting
    // data/list access makes Windows enforce our share mode against later opens.
    private const uint ReadContents = 0x1;
    private const uint WriteContents = 0x2;
    private const uint Synchronize = 0x00100000;
    private const uint ShareRead = 0x1;
    private const uint ShareWrite = 0x2;
    private const uint ShareDelete = 0x4;
    private const uint OpenExisting = 3;
    private const uint BackupSemantics = 0x02000000;
    private const uint OpenReparsePoint = 0x00200000;
    private const uint ReparseAttribute = 0x400;
    private const uint DirectoryAttribute = 0x10;
    private const uint FixedDrive = 3;
    private const uint FileCreate = 2;
    private const uint FileNormal = 0x80;
    private const uint FileNonDirectory = 0x40;
    private const uint FileSynchronous = 0x20;
    private const uint ObjectCaseInsensitive = 0x40;
    private const uint ObjectDontReparse = 0x1000;
    private static readonly string[] RequiredFiles = {
        "synthetic-assembly.SLDASM", "parts\\baseline-5mm.SLDPRT", "parts\\candidate-8mm.SLDPRT"
    };

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "CreateFileW")]
    private static extern SafeFileHandle CreateFile(string name, uint access, uint share,
        IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetFileInformationByHandleEx(SafeFileHandle handle, int infoClass,
        [Out] byte[] data, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out ByHandleFileInformation info);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint QueryDosDevice(string name, StringBuilder target, int capacity);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern uint GetDriveType(string root);
    [DllImport("ntdll.dll", ExactSpelling = true)]
    private static extern int NtCreateFile(out SafeFileHandle handle, uint access,
        ref ObjectAttributes attributes, out IoStatusBlock status, IntPtr allocationSize,
        uint fileAttributes, uint share, uint disposition, uint options, IntPtr ea, uint eaLength);

    [StructLayout(LayoutKind.Sequential)]
    private struct UnicodeString
    {
        public ushort length;
        public ushort maximumLength;
        public IntPtr buffer;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct ObjectAttributes
    {
        public uint length;
        public IntPtr rootDirectory;
        public IntPtr objectName;
        public uint attributes;
        public IntPtr securityDescriptor;
        public IntPtr securityQualityOfService;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct IoStatusBlock
    {
        public IntPtr status;
        public IntPtr information;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct FileTime
    {
        public uint low;
        public uint high;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct ByHandleFileInformation
    {
        public uint attributes;
        public FileTime creationTime;
        public FileTime lastAccessTime;
        public FileTime lastWriteTime;
        public uint volumeSerial;
        public uint sizeHigh;
        public uint sizeLow;
        public uint linkCount;
        public uint fileIndexHigh;
        public uint fileIndexLow;
    }

    public sealed class Identity
    {
        public string path { get; private set; }
        public string volumeSerial { get; private set; }
        public string fileId { get; private set; }
        internal Identity(string pathValue, string volumeValue, string fileValue)
        {
            path = pathValue;
            volumeSerial = volumeValue;
            fileId = fileValue;
        }
    }

    private readonly List<SafeFileHandle> held = new List<SafeFileHandle>();
    private readonly List<Identity> inputFiles = new List<Identity>();
    private readonly string inputPath;
    private readonly string outputPath;
    private readonly string expectedCandidatePath;
    private bool disposed;
    private bool candidateFilesValidated;
    private Identity attemptDirectory;
    private Identity candidateParts;
    private SafeFileHandle candidateHandle;
    private SafeFileHandle candidatePartsHandle;
    public string attemptId { get; private set; }
    public string host { get; private set; }
    public Identity input { get; private set; }
    public Identity candidate { get; private set; }

    private PreparedFilesystemAdmission(string inputRoot, string outputRoot, string exactAttemptId)
    {
        Guid parsed;
        if (!Guid.TryParseExact(exactAttemptId, "D", out parsed) ||
            parsed.ToString("D") != exactAttemptId)
            throw new InvalidOperationException("Expected one canonical attempt ID.");
        attemptId = exactAttemptId;
        host = Environment.MachineName;
        inputPath = LocalPath(inputRoot);
        outputPath = LocalPath(outputRoot);
        expectedCandidatePath = Path.Combine(outputPath, attemptId, "candidate");
        if (ContainsPath(inputPath, expectedCandidatePath) ||
            ContainsPath(expectedCandidatePath, inputPath))
            throw new InvalidOperationException("Input and candidate paths overlap.");
        try
        {
            input = HoldDirectory(inputPath);
            HoldDirectory(outputPath);
            HoldDirectory(Path.Combine(inputPath, "parts"));
            foreach (string relative in RequiredFiles)
                inputFiles.Add(HoldInputFile(Path.Combine(inputPath, relative)));
            AssertDistinct(inputFiles, "Input files alias each other.");
            AssertClosure(inputPath);
        }
        catch
        {
            Dispose();
            throw;
        }
    }

    public static PreparedFilesystemAdmission Begin(string inputRoot, string outputRoot, string exactAttemptId)
    {
        PreparedFilesystemAdmission result = null;
        try
        {
            result = new PreparedFilesystemAdmission(inputRoot, outputRoot, exactAttemptId);
            return result;
        }
        catch
        {
            if (result != null) result.Dispose();
            throw;
        }
    }

    public void BindAttemptDirectory(string attemptPath)
    {
        EnsureOpen();
        if (attemptDirectory != null) throw new InvalidOperationException("Attempt directory was already bound.");
        string expected = Path.GetDirectoryName(expectedCandidatePath);
        if (!String.Equals(LocalPath(attemptPath), expected, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("Attempt directory path differs.");
        attemptDirectory = HoldDirectory(expected);
        if (Same(attemptDirectory, input)) throw new InvalidOperationException("Attempt directory aliases input.");
    }

    public void BindCandidateDirectories(string candidateRoot)
    {
        EnsureOpen();
        if (attemptDirectory == null || candidate != null)
            throw new InvalidOperationException("Attempt directory is missing or candidate was already bound.");
        string path = LocalPath(candidateRoot);
        if (!String.Equals(path, expectedCandidatePath, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("Candidate path differs from the exact attempt.");
        int prior = held.Count;
        try
        {
            Identity found = HoldDirectory(path);
            SafeFileHandle foundHandle = held[held.Count - 1];
            Identity parts = HoldDirectory(Path.Combine(path, "parts"));
            SafeFileHandle partsHandle = held[held.Count - 1];
            if (Same(found, input) || Same(found, attemptDirectory))
                throw new InvalidOperationException("Input and candidate directories alias.");
            candidate = found;
            candidateParts = parts;
            candidateHandle = foundHandle;
            candidatePartsHandle = partsHandle;
        }
        catch
        {
            while (held.Count > prior)
            {
                int last = held.Count - 1;
                held[last].Dispose();
                held.RemoveAt(last);
            }
            throw;
        }
    }

    // Create each fixed candidate entry relative to its admitted parent handle.
    // An empty parts directory can gain a junction attribute without being renamed;
    // a path-based copy could therefore write outside the candidate between checks.
    public void CopyPreparedFiles()
    {
        EnsureOpen();
        if (candidate == null || candidateFilesValidated)
            throw new InvalidOperationException("Candidate copy is unavailable.");
        for (int i = 0; i < RequiredFiles.Length; i++)
        {
            string relative = RequiredFiles[i];
            string leaf = Path.GetFileName(relative);
            SafeFileHandle parent = i == 0 ? candidateHandle : candidatePartsHandle;
            using (FileStream source = new FileStream(Path.Combine(inputPath, relative),
                FileMode.Open, FileAccess.Read, FileShare.Read))
            using (SafeFileHandle destination = CreateRelativeFile(parent, leaf))
            using (FileStream output = new FileStream(destination, FileAccess.Write, 65536, false))
                source.CopyTo(output);
        }
    }

    private static SafeFileHandle CreateRelativeFile(SafeFileHandle parent, string leaf)
    {
        if (String.IsNullOrEmpty(leaf) || leaf.IndexOfAny(new[] { '\\', '/', ':' }) >= 0)
            throw new InvalidOperationException("Candidate filename is not a fixed leaf.");
        IntPtr name = IntPtr.Zero;
        IntPtr unicodePointer = IntPtr.Zero;
        SafeFileHandle created = null;
        try
        {
            name = Marshal.StringToHGlobalUni(leaf);
            UnicodeString unicode = new UnicodeString {
                length = checked((ushort)(leaf.Length * 2)),
                maximumLength = checked((ushort)((leaf.Length + 1) * 2)),
                buffer = name
            };
            unicodePointer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(UnicodeString)));
            Marshal.StructureToPtr(unicode, unicodePointer, false);
            ObjectAttributes attributes = new ObjectAttributes {
                length = (uint)Marshal.SizeOf(typeof(ObjectAttributes)),
                rootDirectory = parent.DangerousGetHandle(),
                objectName = unicodePointer,
                attributes = ObjectCaseInsensitive | ObjectDontReparse
            };
            IoStatusBlock status;
            int result = NtCreateFile(out created, WriteContents | ReadAttributes | Synchronize,
                ref attributes, out status, IntPtr.Zero, FileNormal, ShareRead | ShareWrite,
                FileCreate, FileNonDirectory | FileSynchronous, IntPtr.Zero, 0);
            if (result < 0 || created == null || created.IsInvalid)
                throw new InvalidOperationException("Handle-relative candidate creation failed (NTSTATUS 0x" +
                    ((uint)result).ToString("x8") + ").");
            SafeFileHandle accepted = created;
            created = null;
            return accepted;
        }
        finally
        {
            if (created != null) created.Dispose();
            if (unicodePointer != IntPtr.Zero) Marshal.FreeHGlobal(unicodePointer);
            if (name != IntPtr.Zero) Marshal.FreeHGlobal(name);
        }
    }

    public void BindCandidateFiles()
    {
        EnsureOpen();
        if (candidate == null || candidateFilesValidated)
            throw new InvalidOperationException("Candidate file binding is unavailable.");
        int prior = held.Count;
        try
        {
            CheckCandidateFiles(true);
            candidateFilesValidated = true;
        }
        catch
        {
            while (held.Count > prior)
            {
                int last = held.Count - 1;
                held[last].Dispose();
                held.RemoveAt(last);
            }
            throw;
        }
    }

    private void CheckCandidateFiles(bool hold)
    {
        AssertClosure(expectedCandidatePath);
        List<Identity> files = ReadCandidateFiles(expectedCandidatePath, hold);
        AssertDistinct(files, "Candidate files alias each other.");
        foreach (Identity file in files)
            foreach (Identity source in inputFiles)
                if (Same(file, source)) throw new InvalidOperationException("Candidate file aliases input.");
    }

    public void Recheck()
    {
        EnsureOpen();
        if (candidate == null || !candidateFilesValidated)
            throw new InvalidOperationException("Candidate admission is missing.");
        if (!Same(ReadDirectory(inputPath), input) ||
            !Same(ReadDirectory(Path.GetDirectoryName(expectedCandidatePath)), attemptDirectory) ||
            !Same(ReadDirectory(expectedCandidatePath), candidate) ||
            !Same(ReadDirectory(Path.Combine(expectedCandidatePath, "parts")), candidateParts))
            throw new InvalidOperationException("Directory identity changed during native work.");
        AssertClosure(inputPath);
        for (int i = 0; i < RequiredFiles.Length; i++)
        {
            Identity current = ReadFile(Path.Combine(inputPath, RequiredFiles[i]));
            if (!Same(current, inputFiles[i]))
                throw new InvalidOperationException("Input file identity changed during native work.");
        }
        CheckCandidateFiles(false);
    }

    private List<Identity> ReadCandidateFiles(string root, bool hold)
    {
        List<Identity> result = new List<Identity>();
        foreach (string relative in RequiredFiles)
        {
            string path = Path.Combine(root, relative);
            result.Add(hold ? HoldCandidateFile(path) : ReadFile(path));
        }
        return result;
    }

    private Identity HoldDirectory(string path)
    {
        return OpenChain(path, true, true);
    }
    private Identity ReadDirectory(string path)
    {
        return OpenChain(path, true, false);
    }
    private Identity HoldInputFile(string path)
    {
        SafeFileHandle handle = OpenChecked(path, false, ShareRead);
        held.Add(handle);
        return Identify(path, handle);
    }
    private Identity HoldCandidateFile(string path)
    {
        // Native code may write the file, but no process may replace its entry
        // while this exact attempt owns the candidate.
        SafeFileHandle handle = OpenChecked(path, false, ShareRead | ShareWrite);
        held.Add(handle);
        return Identify(path, handle);
    }
    private Identity ReadFile(string path)
    {
        using (SafeFileHandle handle = OpenChecked(path, false, ShareRead | ShareWrite))
            return Identify(path, handle);
    }

    // Every path component is opened without following its final reparse point.
    // Held directory handles deny deletion/replacement until Dispose.
    private Identity OpenChain(string path, bool directory, bool keep)
    {
        string full = LocalPath(path);
        string root = Path.GetPathRoot(full);
        string[] pieces = full.Substring(root.Length).Split(new[] { '\\' }, StringSplitOptions.RemoveEmptyEntries);
        List<SafeFileHandle> opened = new List<SafeFileHandle>();
        try
        {
            string current = root;
            SafeFileHandle handle = OpenChecked(current, true, ShareRead | ShareWrite);
            opened.Add(handle);
            for (int i = 0; i < pieces.Length; i++)
            {
                current = Path.Combine(current, pieces[i]);
                handle = OpenChecked(current, i < pieces.Length - 1 || directory, ShareRead | ShareWrite);
                opened.Add(handle);
            }
            Identity identity = Identify(full, handle);
            if (keep) held.AddRange(opened);
            else foreach (SafeFileHandle item in opened) item.Dispose();
            return identity;
        }
        catch
        {
            foreach (SafeFileHandle item in opened) item.Dispose();
            throw;
        }
    }

    private static SafeFileHandle OpenChecked(string path, bool directory, uint share)
    {
        SafeFileHandle handle = CreateFile(path, ReadAttributes | ReadContents, share, IntPtr.Zero,
            OpenExisting, BackupSemantics | OpenReparsePoint, IntPtr.Zero);
        if (handle.IsInvalid)
        {
            int code = Marshal.GetLastWin32Error();
            handle.Dispose();
            throw new Win32Exception(code, "Filesystem identity could not be opened.");
        }
        ByHandleFileInformation info;
        if (!GetFileInformationByHandle(handle, out info))
        {
            int code = Marshal.GetLastWin32Error();
            handle.Dispose();
            throw new Win32Exception(code, "Filesystem attributes could not be observed.");
        }
        if ((info.attributes & ReparseAttribute) != 0 ||
            ((info.attributes & DirectoryAttribute) != 0) != directory)
        {
            handle.Dispose();
            throw new InvalidOperationException("Reparse point or unexpected filesystem entry denied.");
        }
        if (!directory && info.linkCount != 1)
        {
            handle.Dispose();
            throw new InvalidOperationException("Hard-linked prepared file denied.");
        }
        return handle;
    }

    private static Identity Identify(string path, SafeFileHandle handle)
    {
        byte[] data = new byte[24];
        // FileIdInfo = 18; FILE_ID_INFO is an 8-byte volume serial and 16-byte ID.
        if (!GetFileInformationByHandleEx(handle, 18, data, (uint)data.Length))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "FILE_ID_INFO is unavailable.");
        string serial = BitConverter.ToUInt64(data, 0).ToString("x16");
        byte[] id = new byte[16];
        Buffer.BlockCopy(data, 8, id, 0, id.Length);
        return new Identity(path, serial, BitConverter.ToString(id).Replace("-", "").ToLowerInvariant());
    }

    private static void AssertClosure(string root)
    {
        string[] top = Directory.GetFileSystemEntries(root);
        string[] parts = Directory.GetFileSystemEntries(Path.Combine(root, "parts"));
        if (top.Length != 2 || parts.Length != 2)
            throw new InvalidOperationException("Prepared dependency closure changed.");
        bool assembly = false;
        bool partsDirectory = false;
        foreach (string entry in top)
        {
            string name = Path.GetFileName(entry);
            if (String.Equals(name, "synthetic-assembly.SLDASM", StringComparison.OrdinalIgnoreCase)) assembly = true;
            else if (String.Equals(name, "parts", StringComparison.OrdinalIgnoreCase)) partsDirectory = true;
            else throw new InvalidOperationException("Unsupported prepared dependency.");
        }
        bool baseline = false;
        bool companion = false;
        foreach (string entry in parts)
        {
            string name = Path.GetFileName(entry);
            if (String.Equals(name, "baseline-5mm.SLDPRT", StringComparison.OrdinalIgnoreCase)) baseline = true;
            else if (String.Equals(name, "candidate-8mm.SLDPRT", StringComparison.OrdinalIgnoreCase)) companion = true;
            else throw new InvalidOperationException("Unsupported prepared dependency.");
        }
        if (!assembly || !partsDirectory || !baseline || !companion)
            throw new InvalidOperationException("Prepared dependency closure is incomplete.");
    }

    private static bool Same(Identity a, Identity b)
    {
        return a.volumeSerial == b.volumeSerial && a.fileId == b.fileId;
    }
    private static void AssertDistinct(List<Identity> files, string message)
    {
        for (int i = 0; i < files.Count; i++)
            for (int j = i + 1; j < files.Count; j++)
                if (Same(files[i], files[j])) throw new InvalidOperationException(message);
    }
    private static bool ContainsPath(string parent, string child)
    {
        return String.Equals(parent, child, StringComparison.OrdinalIgnoreCase) ||
            child.StartsWith(parent.TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase);
    }
    private static string LocalPath(string path)
    {
        if (String.IsNullOrWhiteSpace(path) || path.Length < 3 ||
            !Char.IsLetter(path[0]) || path[1] != ':' || path[2] != '\\' ||
            path.IndexOfAny(new[] { '/', '\0', '\r', '\n' }) >= 0)
            throw new InvalidOperationException("Expected an absolute local drive path.");
        string full = Path.GetFullPath(path).TrimEnd('\\');
        if (full.Length == 2) full += "\\";
        string root = Path.GetPathRoot(full);
        if (GetDriveType(root) != FixedDrive)
            throw new InvalidOperationException("A fixed local drive is required.");
        StringBuilder target = new StringBuilder(1024);
        if (QueryDosDevice(root.Substring(0, 2), target, target.Capacity) == 0)
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Drive mapping is unavailable.");
        string mapping = target.ToString();
        if (mapping.StartsWith("\\??\\", StringComparison.OrdinalIgnoreCase) ||
            mapping.StartsWith("\\DosDevices\\", StringComparison.OrdinalIgnoreCase) ||
            !mapping.StartsWith("\\Device\\HarddiskVolume", StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("Substituted or unsupported drive denied.");
        string[] pieces = full.Substring(root.Length).Split(new[] { '\\' }, StringSplitOptions.RemoveEmptyEntries);
        foreach (string piece in pieces)
            if (piece == "." || piece == ".." || piece.EndsWith(".") || piece.EndsWith(" ") ||
                piece.IndexOf(':') >= 0)
                throw new InvalidOperationException("Ambiguous path component denied.");
        return full;
    }
    private void EnsureOpen()
    {
        if (disposed) throw new ObjectDisposedException("PreparedFilesystemAdmission");
    }
    public void Dispose()
    {
        if (disposed) return;
        disposed = true;
        for (int i = held.Count - 1; i >= 0; i--) held[i].Dispose();
        held.Clear();
    }
}
