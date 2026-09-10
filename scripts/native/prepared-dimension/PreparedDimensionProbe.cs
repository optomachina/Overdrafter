using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Threading;
using System.Web.Script.Serialization;
using SolidWorks.Interop.sldworks;

// Narrow extraction of native04 editing and the corrected assembly readback.
// The supervisor owns the native process. Binding the ROT never grants ownership.
partial class PreparedDimensionProbe
{
    const string NativeExe = @"C:\Program Files\SOLIDWORKS 2022\SOLIDWORKS\SLDWORKS.exe";
    const string NativeHash = "6384c0829bac149831be5fdc9e705c90612273d25b46fdff5e5760d11e22d6cc";
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 4000000 };
    static readonly Dictionary<string, object> Report = new Dictionary<string, object>();
    static readonly Dictionary<string, object> Checks = new Dictionary<string, object>();
    static readonly List<object> Owned = new List<object>();
    static readonly List<string> ReleaseErrors = new List<string>();
    static int ExpectedPid, ExpectedSession;
    static long ExpectedTicks;
    static ISldWorks Sw;
    static IModelDoc2 AssemblyDoc;
    static List<IModelDoc2> Documents;
    static IModelDoc2[] PartDocs;
    static string Package, AssemblyPath;
    static string[] Parts;
    static double TargetDepth, ExpectedDepth;

    static void Need(bool condition, string stage)
    {
        Checks[stage] = condition;
        if (!condition) throw new InvalidOperationException(stage);
    }
    static T Call<T>(string stage, Func<T> operation)
    {
        Report["stage"] = stage;
        Console.Error.WriteLine(Json.Serialize(new { utc = DateTime.UtcNow.ToString("o"), stage = stage, phase = "before" }));
        Console.Error.Flush();
        T value = operation();
        Console.Error.WriteLine(Json.Serialize(new { stage = stage, phase = "returned" }));
        Console.Error.Flush();
        return value;
    }
    static T Own<T>(string stage, Func<object> operation) where T : class
    {
        object value = Call(stage, operation);
        if (value != null && Marshal.IsComObject(value)) Owned.Add(value);
        return (T)value;
    }
    static bool Same(object first, object second)
    {
        if (first == null || second == null) return false;
        IntPtr a = Marshal.GetIUnknownForObject(first), b = Marshal.GetIUnknownForObject(second);
        try { return a == b; } finally { Marshal.Release(a); Marshal.Release(b); }
    }
    static string Hash(string path)
    {
        using (var stream = File.OpenRead(path)) using (var hash = SHA256.Create())
            return BitConverter.ToString(hash.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
    }
    static bool PathEqual(string first, string second)
    {
        return !String.IsNullOrEmpty(first) && !String.IsNullOrEmpty(second) &&
            String.Equals(Path.GetFullPath(first), Path.GetFullPath(second), StringComparison.OrdinalIgnoreCase);
    }
    static bool InPackage(string path)
    {
        return Path.GetFullPath(path).StartsWith(Package.TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase);
    }
    static void NativeIdentity()
    {
        Process[] all = Process.GetProcessesByName("SLDWORKS");
        try {
            Need(all.Length == 1, "native_singleton");
            Process process = all[0];
            Need(process.Id == ExpectedPid && process.SessionId == ExpectedSession &&
                ExpectedSession == Process.GetCurrentProcess().SessionId &&
                process.StartTime.ToUniversalTime().Ticks == ExpectedTicks, "native_identity");
            Need(PathEqual(process.MainModule.FileName, NativeExe), "native_executable_path");
            var version = process.MainModule.FileVersionInfo;
            Need(version.FileVersion == "30.5.0.0049" && version.ProductVersion == "30.5.0.0049" &&
                Hash(NativeExe) == NativeHash, "native_binary");
        } finally { foreach (Process process in all) process.Dispose(); }
        if (Sw != null) Need(Sw.GetProcessID() == ExpectedPid && Sw.RevisionNumber() == "30.5.0", "native_api_identity");
    }
    static void ReleaseOwned()
    {
        for (int i = Owned.Count - 1; i >= 0; i--) {
            try { Marshal.ReleaseComObject(Owned[i]); }
            catch (Exception error) { ReleaseErrors.Add(error.Message); }
        }
        Owned.Clear();
    }

    [STAThread] static int Main(string[] args)
    {
        AppDomain.CurrentDomain.AssemblyResolve += delegate(object sender, ResolveEventArgs error) {
            string name = new AssemblyName(error.Name).Name;
            if (name == "SolidWorks.Interop.sldworks")
                return Assembly.LoadFrom(@"C:\Program Files\SOLIDWORKS 2022\SOLIDWORKS\api\redist\SolidWorks.Interop.sldworks.dll");
            return null;
        };
        Report["outcome"] = "failed"; Report["checks"] = Checks; Report["releaseErrors"] = ReleaseErrors;
        Report["helperPid"] = Process.GetCurrentProcess().Id;
        try {
            if (args.Length == 2 && args[0] == "--check-pinned-inputs") {
                CheckPinnedInputs(args[1]);
                Report["outcome"] = "passed";
                Console.WriteLine(Json.Serialize(Report));
                return 0;
            }
            Need(args.Length == 4, "arguments");
            ExpectedPid = Int32.Parse(args[0], CultureInfo.InvariantCulture);
            ExpectedTicks = Int64.Parse(args[1], CultureInfo.InvariantCulture);
            ExpectedSession = Int32.Parse(args[2], CultureInfo.InvariantCulture);
            Need(System.Environment.Is64BitProcess && Thread.CurrentThread.GetApartmentState() == ApartmentState.STA, "x64_STA");
            NativeIdentity(); Run(args[3]); Report["outcome"] = "passed";
        } catch (Exception error) {
            Report["error"] = error.Message; Report["hresult"] = "0x" + error.HResult.ToString("X8");
        }
        if (ReleaseErrors.Count != 0) Report["outcome"] = "failed";
        Console.WriteLine(Json.Serialize(Report));
        return (string)Report["outcome"] == "passed" ? 0 : 2;
    }

    // Regression lane for AssemblyRecovery's shared reader: no settings override,
    // no process binding and no COM. It reads/hashes only the pinned input closure.
    [MethodImpl(MethodImplOptions.NoInlining)] static void CheckPinnedInputs(string root)
    {
        Report["mode"] = "pinned_input_files_only";
        Need(Path.IsPathRooted(root), "absolute_input_root");
        Package = Path.GetFullPath(root);
        AssemblyPath = Path.Combine(Package, "synthetic-assembly.SLDASM");
        Parts = new[] { Path.Combine(Package, "parts", "baseline-5mm.SLDPRT"), Path.Combine(Package, "parts", "candidate-8mm.SLDPRT") };
        CheckInitialFiles();
    }

    // Keep interop loading after the resolver, matching the demonstrated bootstrap.
    [MethodImpl(MethodImplOptions.NoInlining)] static void Run(string settingsPath)
    {
        Need(typeof(ISldWorks).Assembly.GetName().Version.ToString() == "30.5.0.49" &&
            typeof(ISldWorks).GUID == new Guid("83A33D22-27C5-11CE-BFD4-00400513BB57"), "interop_identity");
        var settings = Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(settingsPath));
        Package = Path.GetFullPath((string)settings["candidateRoot"]);
        Need(Path.IsPathRooted(Package) && Package.Length <= 140, "private_package_path");
        TargetDepth = Convert.ToDouble(settings["depthMm"], CultureInfo.InvariantCulture) / 1000;
        Need(Finite(TargetDepth) && TargetDepth >= .006 && TargetDepth <= .010, "depth_range");
        ExpectedDepth = Convert.ToDouble(settings["expectedDepthMm"], CultureInfo.InvariantCulture) / 1000;
        Need(Finite(ExpectedDepth) && (ExpectedDepth == .005 || (ExpectedDepth >= .006 && ExpectedDepth <= .010)), "expected_depth_range");
        ReadInputIdentities(settings["inputFiles"]);
        foreach (string key in new[] { "jobId", "attemptId", "requestSha256", "contextSha256", "depthMm", "expectedDepthMm" }) Report[key] = settings[key];
        Report["candidateRoot"] = Package; Report["nativePid"] = ExpectedPid;
        Report["nativeStartTicks"] = ExpectedTicks.ToString(CultureInfo.InvariantCulture);
        Parts = new[] { Path.Combine(Package, "parts", "baseline-5mm.SLDPRT"), Path.Combine(Package, "parts", "candidate-8mm.SLDPRT") };
        AssemblyPath = Path.Combine(Package, "synthetic-assembly.SLDASM");
        Documents = new List<IModelDoc2>(); PartDocs = new IModelDoc2[2];
        CheckInitialFiles();
        object application = null;
        try {
            application = Call<object>("bind_existing", () => Marshal.GetActiveObject("SldWorks.Application.30"));
            Sw = (ISldWorks)application; NativeIdentity();
            Need(Sw.StartupProcessCompleted && Sw.GetDocumentCount() == 0, "initial_empty_ready");
            ExecutePackage(); NativeIdentity(); Need(Sw.GetDocumentCount() == 0, "final_empty");
        } finally {
            // No automatic CloseDoc, ExitApp, retry, or forced native cleanup on failure.
            ReleaseOwned(); Sw = null;
            if (application != null) {
                try { Marshal.ReleaseComObject(application); }
                catch (Exception error) { ReleaseErrors.Add(error.Message); }
            }
        }
    }
}
