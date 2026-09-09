using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using SolidWorks.Interop.sldworks;

// The explicit /main prevents the linked dimension-editing entry point from running.
class StepPreviewBootstrap
{
    [STAThread] static int Main(string[] args)
    {
        AppDomain.CurrentDomain.AssemblyResolve += delegate(object sender, ResolveEventArgs error) {
            if (new AssemblyName(error.Name).Name == "SolidWorks.Interop.sldworks")
                return Assembly.LoadFrom(@"C:\Program Files\SOLIDWORKS 2022\SOLIDWORKS\api\redist\SolidWorks.Interop.sldworks.dll");
            return null;
        };
        return PreparedDimensionProbe.PreviewMain(args);
    }
}

// Read-only composition with the unchanged, previously exercised private-package verifier.
partial class PreparedDimensionProbe
{
    const int StepLimit = 2000000;
    static Assembly StepConstants;

    [MethodImpl(MethodImplOptions.NoInlining)] public static int PreviewMain(string[] args)
    {
        Report["outcome"] = "failed"; Report["checks"] = Checks; Report["releaseErrors"] = ReleaseErrors;
        Report["helperPid"] = Process.GetCurrentProcess().Id;
        try {
            Need(args.Length == 4, "preview_arguments");
            ExpectedPid = Int32.Parse(args[0], CultureInfo.InvariantCulture);
            ExpectedTicks = Int64.Parse(args[1], CultureInfo.InvariantCulture);
            ExpectedSession = Int32.Parse(args[2], CultureInfo.InvariantCulture);
            Need(System.Environment.Is64BitProcess && Thread.CurrentThread.GetApartmentState() == ApartmentState.STA, "x64_STA");
            NativeIdentity(); RunPreview(args[3]); Report["outcome"] = "passed";
        } catch (Exception error) {
            Report["error"] = error.Message; Report["hresult"] = "0x" + error.HResult.ToString("X8");
        }
        if (ReleaseErrors.Count != 0) Report["outcome"] = "failed";
        Console.WriteLine(Json.Serialize(Report));
        return (string)Report["outcome"] == "passed" ? 0 : 2;
    }

    static int StepEnum(string type, string member)
    {
        return Convert.ToInt32(Enum.Parse(StepConstants.GetType("SolidWorks.Interop.swconst." + type, true), member, false), CultureInfo.InvariantCulture);
    }

    // Only getters: reject export modes that would omit solids, transform the assembly,
    // split its closure into other files, or prompt for configuration selection.
    static Dictionary<string, object> ReadStepPreferences(IModelDocExtension extension)
    {
        var values = new Dictionary<string, object>();
        int geometry = Sw.GetUserPreferenceIntegerValue(StepEnum("swUserPreferenceIntegerValue_e", "swStepExportPreference"));
        int ap = Sw.GetUserPreferenceIntegerValue(StepEnum("swUserPreferenceIntegerValue_e", "swStepAP"));
        bool configurations = extension.GetUserPreferenceToggle(StepEnum("swUserPreferenceToggle_e", "swStepExportConfigurationData"), 0);
        string coordinate = Sw.GetUserPreferenceStringValue(StepEnum("swUserPreferenceStringValue_e", "swExportOutputCoordinateSystem"));
        values["geometry"] = geometry; values["ap"] = ap; values["configurationData"] = configurations;
        values["outputCoordinateSystem"] = coordinate;
        Need(geometry == StepEnum("swAcisOutputGeometryPreference_e", "swAcisOutputAsSolidAndSurface"), "step_solid_surface_mode");
        Need(ap == 203 || ap == 214, "step_supported_ap");
        Need(!configurations && String.IsNullOrEmpty(coordinate), "step_no_configuration_prompt_or_coordinate_override");
        Type toggles = StepConstants.GetType("SolidWorks.Interop.swconst.swUserPreferenceToggle_e", true);
        if (Enum.IsDefined(toggles, "swStepExportAtomicSave")) {
            bool atomic = Sw.GetUserPreferenceToggle(StepEnum("swUserPreferenceToggle_e", "swStepExportAtomicSave"));
            values["atomicSave"] = atomic; Need(!atomic, "step_single_file_mode");
        }
        return values;
    }

    static void PreviewFiles(object raw, string phase)
    {
        var files = raw as IEnumerable; Need(files != null, "preview_file_array");
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var observations = new List<object>();
        foreach (object item in files) {
            var file = item as Dictionary<string, object>; Need(file != null, "preview_file_object");
            string name = (string)file["path"];
            Need((name == "synthetic-assembly.SLDASM" || name == "parts/baseline-5mm.SLDPRT" ||
                name == "parts/candidate-8mm.SLDPRT") && seen.Add(name), "preview_file_name");
            string path = Path.Combine(Package, name.Replace('/', '\\'));
            var info = new FileInfo(path); string hash = Hash(path);
            observations.Add(new { path = name, bytes = info.Length, sha256 = hash });
            Need(InPackage(path) && (info.Attributes & FileAttributes.ReparsePoint) == 0 &&
                info.Length == Convert.ToInt64(file["bytes"], CultureInfo.InvariantCulture) &&
                hash == (string)file["sha256"], phase + "_exact_native_file");
        }
        Report[phase + "NativeFiles"] = observations; Need(seen.Count == 3, "preview_three_files");
    }

    static void ExportStep(string stepPath)
    {
        ActivateAssembly(); Need(AssemblyDoc.IsOpenedReadOnly(), "preview_assembly_readonly");
        foreach (IComponent2 component in Components(true)) Need(!component.IsHidden(false), "preview_component_visible");
        AssemblyDoc.ClearSelection2(true);
        var selections = Own<ISelectionMgr>("SelectionManager", () => AssemblyDoc.SelectionManager);
        Need(selections.GetSelectedObjectCount2(-1) == 0, "preview_whole_assembly_selection");
        var extension = Own<IModelDocExtension>("preview_Extension", () => AssemblyDoc.Extension);
        var preferences = ReadStepPreferences(extension); Report["stepPreferencesBefore"] = preferences;
        Need(!File.Exists(stepPath) && Directory.GetFileSystemEntries(Path.GetDirectoryName(stepPath)).Length == 0, "fresh_step_destination");
        NativeIdentity(); int errors = 0, warnings = 0;
        bool saved = Call("SaveAs3_STEP", () => extension.SaveAs3(stepPath, 0, 1, null, null, ref errors, ref warnings));
        Report["stepSave"] = new { returned = saved, errors = errors, warnings = warnings };
        Need(saved && errors == 0 && warnings == 0, "step_save_success");
        Need(PathEqual(AssemblyDoc.GetPathName(), AssemblyPath) && AssemblyDoc.IsOpenedReadOnly(), "native_identity_after_step");
        var after = ReadStepPreferences(extension); Report["stepPreferencesAfter"] = after;
        Need(Json.Serialize(preferences) == Json.Serialize(after), "step_preferences_unchanged");
        InspectAssembly("after_export");
        var info = new FileInfo(stepPath);
        Need(info.Exists && info.Length > 0 && info.Length <= StepLimit &&
            Directory.GetFileSystemEntries(info.DirectoryName).Length == 1, "single_bounded_step_file");
        string text = Encoding.ASCII.GetString(File.ReadAllBytes(stepPath)).Trim();
        Need(text.StartsWith("ISO-10303-21;", StringComparison.Ordinal) &&
            text.EndsWith("END-ISO-10303-21;", StringComparison.Ordinal), "step_exchange_envelope");
        Report["step"] = new { fileName = "assembly.step", bytes = info.Length, sha256 = Hash(stepPath) };
    }

    [MethodImpl(MethodImplOptions.NoInlining)] static void RunPreview(string settingsPath)
    {
        Need(typeof(ISldWorks).Assembly.GetName().Version.ToString() == "30.5.0.49" &&
            typeof(ISldWorks).GUID == new Guid("83A33D22-27C5-11CE-BFD4-00400513BB57"), "interop_identity");
        var settings = Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(settingsPath));
        Package = Path.GetFullPath((string)settings["candidateRoot"]);
        string stepPath = Path.GetFullPath((string)settings["stepPath"]);
        Need(Package.Length <= 140 && !InPackage(stepPath) && Path.GetFileName(stepPath) == "assembly.step", "preview_private_paths");
        TargetDepth = Convert.ToDouble(settings["depthMm"], CultureInfo.InvariantCulture) / 1000;
        string role = (string)settings["role"];
        Need((role == "baseline" && TargetDepth == .005) ||
            (role == "candidate" && Finite(TargetDepth) && TargetDepth >= .006 && TargetDepth <= .010), "preview_role_depth");
        foreach (string key in new[] { "role", "contextSha256", "requestSha256", "resultSha256", "depthMm" }) Report[key] = settings[key];
        Report["candidateRoot"] = Package; Report["nativePid"] = ExpectedPid;
        Report["nativeStartTicks"] = ExpectedTicks.ToString(CultureInfo.InvariantCulture); Report["nativeVersion"] = "30.5.0";
        string constants = @"C:\Program Files\SOLIDWORKS 2022\SOLIDWORKS\api\redist\SolidWorks.Interop.swconst.dll";
        Need(Hash(constants) == (string)settings["swconstSha256"] &&
            AssemblyName.GetAssemblyName(constants).Version.ToString() == "30.5.0.49", "step_constants_identity");
        StepConstants = Assembly.LoadFrom(constants);
        Parts = new[] { Path.Combine(Package, "parts", "baseline-5mm.SLDPRT"), Path.Combine(Package, "parts", "candidate-8mm.SLDPRT") };
        AssemblyPath = Path.Combine(Package, "synthetic-assembly.SLDASM");
        Documents = new List<IModelDoc2>(); PartDocs = new IModelDoc2[2];
        PreviewFiles(settings["nativeFiles"], "before");
        object application = null;
        try {
            application = Call<object>("bind_existing", () => Marshal.GetActiveObject("SldWorks.Application.30"));
            Sw = (ISldWorks)application; NativeIdentity();
            Need(Sw.StartupProcessCompleted && Sw.GetDocumentCount() == 0, "initial_empty_ready");
            LoadPackage(TargetDepth, true, "preview"); ExportStep(stepPath); ClosePackage();
            NativeIdentity(); Need(Sw.GetDocumentCount() == 0, "final_empty");
            PreviewFiles(settings["nativeFiles"], "after");
        } finally {
            // Uncertain failure never triggers native termination, document close, or retry.
            ReleaseOwned(); Sw = null;
            if (application != null) {
                try { Marshal.ReleaseComObject(application); }
                catch (Exception error) { ReleaseErrors.Add(error.Message); }
            }
        }
    }
}
