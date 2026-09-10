using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text.RegularExpressions;
using SolidWorks.Interop.sldworks;

partial class PreparedDimensionProbe
{
    // AssemblyRecovery links this reader without dimension settings. Keep its
    // pinned seed defaults; only the dimension entry point supplies successors.
    static readonly string[] InputHashes = {
        "90f017c100732cdd24d30ae01e7e64856ba65c8a9c77df4aa2f85ad4f57d9e3a",
        "e4ff1efb9ead3efd44ad24262dee670bee7de82a894ea0a0d998a58a3fd8b8aa",
        "b08031412dcdf878680d775d1f9d571c9556d6e9ebf9fce01f83811d36e13898" };
    static readonly long[] InputLengths = { 59987, 56144, 56171 };
    // The supervisor validates v1 seed or v2 predecessor provenance before writing
    // these settings. The probe rechecks the exact package bytes before any COM edit.
    static void ReadInputIdentities(object raw)
    {
        IList files = raw as IList;
        Need(files != null && files.Count == 3, "three_input_identities");
        string[] paths = { "synthetic-assembly.SLDASM", "parts/baseline-5mm.SLDPRT", "parts/candidate-8mm.SLDPRT" };
        for (int i = 0; i < 3; i++) {
            var file = files[i] as Dictionary<string, object>;
            Need(file != null && file.Count == 3 && file.ContainsKey("path") && file.ContainsKey("bytes") && file.ContainsKey("sha256"), "input_identity_fields");
            Need(file["path"] is string && (string)file["path"] == paths[i] && file["sha256"] is string, "input_identity_path");
            InputHashes[i] = (string)file["sha256"];
            Need(Regex.IsMatch(InputHashes[i], "\\A[0-9a-f]{64}\\z"), "input_identity_hash");
            double length = Convert.ToDouble(file["bytes"], CultureInfo.InvariantCulture);
            Need(Finite(length) && length >= 1 && length <= 16000000 && Math.Floor(length) == length, "input_identity_length");
            InputLengths[i] = (long)length;
        }
        Need(InputHashes[2] == "b08031412dcdf878680d775d1f9d571c9556d6e9ebf9fce01f83811d36e13898" && InputLengths[2] == 56171, "pinned_companion");
        if (ExpectedDepth == .005) {
            Need(InputHashes[0] == "90f017c100732cdd24d30ae01e7e64856ba65c8a9c77df4aa2f85ad4f57d9e3a" && InputLengths[0] == 59987 &&
                InputHashes[1] == "e4ff1efb9ead3efd44ad24262dee670bee7de82a894ea0a0d998a58a3fd8b8aa" && InputLengths[1] == 56144, "pinned_seed");
        }
    }
    static void CheckInitialFiles()
    {
        string[] paths = { AssemblyPath, Parts[0], Parts[1] };
        for (int i = 0; i < paths.Length; i++)
            Need(InPackage(paths[i]) && new FileInfo(paths[i]).Length == InputLengths[i] &&
                Hash(paths[i]) == InputHashes[i], "exact_private_input_" + i);
    }
    static List<IModelDoc2> Loaded()
    {
        object raw = Call<object>("GetDocuments", () => Sw.GetDocuments());
        object[] values = raw as object[]; Need(raw == null || values != null, "document_array");
        var result = new List<IModelDoc2>();
        if (values != null) foreach (object value in values) { Owned.Add(value); result.Add((IModelDoc2)value); }
        Need(Sw.GetDocumentCount() == result.Count, "document_count");
        return result;
    }
    static void Scope()
    {
        NativeIdentity(); var actual = Loaded(); Need(actual.Count == Documents.Count, "known_document_count");
        foreach (IModelDoc2 model in actual) {
            bool known = false;
            foreach (IModelDoc2 expected in Documents) if (Same(model, expected)) { known = true; break; }
            string path = model.GetPathName();
            Need(known && InPackage(path) && (PathEqual(path, AssemblyPath) ||
                PathEqual(path, Parts[0]) || PathEqual(path, Parts[1])), "known_private_document_identity");
        }
    }
    static string[] Strings(object raw)
    {
        if (raw == null) return new string[0];
        Array array = raw as Array; Need(array != null && array.Rank == 1, "string_array");
        var values = new List<string>();
        foreach (object value in array) { Need(value is string, "string_array_item"); values.Add((string)value); }
        return values.ToArray();
    }
    static string Config(IModelDoc2 model)
    {
        Need(model.GetConfigurationCount() == 1, "one_configuration");
        string[] names = Strings(Call<object>("GetConfigurationNames", () => model.GetConfigurationNames()));
        var manager = Own<IConfigurationManager>("ConfigurationManager", () => model.ConfigurationManager);
        var active = Own<IConfiguration>("ActiveConfiguration", () => manager.ActiveConfiguration);
        Need(names.Length == 1 && names[0] == "Default" && active != null && active.Name == "Default", "default_configuration");
        return active.Name;
    }
    static void Dependencies(IModelDoc2 model, string[] expected, string phase)
    {
        var extension = Own<IModelDocExtension>("Extension", () => model.Extension);
        string[] raw = Strings(Call<object>("GetDependencies", () => extension.GetDependencies(true, false, false, true, true)));
        Report[phase + "Dependencies"] = raw; Need(raw.Length % 2 == 0, "dependency_pairs");
        var paths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        for (int i = 0; i < raw.Length; i += 2) {
            Need(!String.IsNullOrWhiteSpace(raw[i]) && !String.IsNullOrWhiteSpace(raw[i + 1]) &&
                raw[i].IndexOf('|') < 0 && raw[i + 1].IndexOf('|') < 0, "dependency_pair_valid");
            string path = Path.GetFullPath(raw[i + 1]);
            Need(InPackage(path) && File.Exists(path) && paths.Add(path), "unique_private_dependency");
        }
        Need(paths.Count == expected.Length, "dependency_count");
        foreach (string path in expected) Need(paths.Contains(Path.GetFullPath(path)), "exact_dependency");
    }
    static IModelDoc2 OpenPrivate(string path, int type, bool readOnly, string phase)
    {
        Scope(); int errors = 0, warnings = 0;
        int options = 1; if (readOnly) options |= 2; if (type == 2) options |= 64;
        IModelDoc2 model;
#if OVD_QUALIFY_NATIVE_CALL
        using (QualifyNativeOpen(path, phase))
#endif
        { model = Own<IModelDoc2>("OpenDoc6", () => Sw.OpenDoc6(path, type, options, "Default", ref errors, ref warnings)); }
        if (model != null) { Documents.Add(model); if (type == 2) AssemblyDoc = model; }
        Report[phase + "Open"] = new { path = path, options = options, errors = errors, warnings = warnings, returned = model != null };
        bool warningsAccepted = warnings == 0;
        if (type == 2) warningsAccepted = (warnings & ~32) == 0;
        Need(model != null && errors == 0 && warningsAccepted, phase + "_open");
        Need(PathEqual(model.GetPathName(), path) && model.GetType() == type &&
            model.IsOpenedReadOnly() == readOnly && Config(model) == "Default", phase + "_admission");
        Scope(); return model;
    }
    static void LoadPackage(double baselineDepth, bool assemblyReadOnly, string phase)
    {
        Need(Documents.Count == 0, "empty_before_package");
        for (int i = 0; i < 2; i++) {
            PartDocs[i] = OpenPrivate(Parts[i], 1, true, phase + "_part_" + i);
            double height = .008; if (i == 0) height = baselineDepth;
            MeasurePart(PartDocs[i], height, phase + "_geometry_" + i);
            Need(PartDocs[i].IsOpenedReadOnly(), "preloaded_part_readonly");
        }
        AssemblyDoc = OpenPrivate(AssemblyPath, 2, assemblyReadOnly, phase + "_assembly");
        // Actual loaded identities and component paths must pass before any dimension edit.
        InspectAssembly(phase);
    }
    static List<IComponent2> Components(bool top)
    {
        object raw = Call<object>("GetComponents", () => ((IAssemblyDoc)AssemblyDoc).GetComponents(top));
        object[] values = raw as object[]; Need(values != null && values.Length == 2, "two_components");
        var result = new List<IComponent2>();
        foreach (object value in values) { Owned.Add(value); result.Add((IComponent2)value); }
        return result;
    }
    static void ActivateAssembly()
    {
        Scope(); int error = 0;
        object activated = Own<object>("ActivateDoc3", () => Sw.ActivateDoc3(AssemblyDoc.GetTitle(), false, 1, ref error));
        Need(error == 0 && Same(activated, AssemblyDoc), "assembly_activation");
        Need(Same(Own<object>("ActiveDoc", () => Sw.ActiveDoc), AssemblyDoc), "active_assembly_identity");
    }
    static double[] InspectTransform(IComponent2 component, int index)
    {
        var transform = Own<IMathTransform>("Transform2", () => component.Transform2);
        Need(transform != null, "transform_present");
        double[] values = Call<object>("ArrayData", () => transform.ArrayData) as double[];
        Need(values != null && values.Length == 16, "transform_length");
        double x = 0; if (index == 1) x = .040;
        double[] expected = { 1, 0, 0, 0, 1, 0, 0, 0, 1, x, 0, 0, 1, 0, 0, 0 };
        for (int i = 0; i < 16; i++) {
            Need(Finite(values[i]), "finite_transform");
            if (i >= 13) continue; // SOLIDWORKS' final three slots are unused diagnostics.
            double tolerance = 1e-10; if (i >= 9 && i <= 11) tolerance = 1e-8;
            Need(Math.Abs(values[i] - expected[i]) <= tolerance, "unchanged_fixed_transform");
        }
        return values;
    }
    static void InspectAssembly(string phase)
    {
        ActivateAssembly(); Need(Call("assembly.ForceRebuild3", () => AssemblyDoc.ForceRebuild3(false)), "assembly_rebuild");
        Need(Config(AssemblyDoc) == "Default", "assembly_configuration");
        var top = Components(true); var recursive = Components(false);
        Need(!Same(top[0], top[1]), "distinct_occurrences");
        foreach (IComponent2 component in top) {
            int matches = 0; foreach (IComponent2 other in recursive) if (Same(component, other)) matches++;
            Need(matches == 1, "same_top_recursive_components");
        }
        var found = new HashSet<string>(StringComparer.OrdinalIgnoreCase); var rows = new List<object>();
        Report[phase + "Occurrences"] = rows;
        foreach (IComponent2 component in top) {
            string path = component.GetPathName(); int index = -1;
            if (PathEqual(path, Parts[0])) index = 0; else if (PathEqual(path, Parts[1])) index = 1;
            Need(index >= 0 && InPackage(path) && found.Add(Path.GetFullPath(path)), "actual_private_component_path");
            var model = Own<IModelDoc2>("GetModelDoc2", () => component.GetModelDoc2());
            int suppression = component.GetSuppression2();
            string expectedName = "baseline-5mm-1"; if (index == 1) expectedName = "candidate-8mm-1";
            Need(model != null && Same(model, PartDocs[index]) && PathEqual(model.GetPathName(), Parts[index]) &&
                model.IsOpenedReadOnly() && Config(model) == "Default" && component.ReferencedConfiguration == "Default" &&
                !component.IsVirtual && component.IsFixed() && (suppression == 2 || suppression == 3) &&
                component.Name2 == expectedName, "component_identity_configuration_state");
            rows.Add(new { name = component.Name2, path = path, modelPath = model.GetPathName(), configuration = "Default",
                fixedState = component.IsFixed(), suppression = suppression, readOnly = model.IsOpenedReadOnly(), transform = InspectTransform(component, index) });
            Dependencies(model, new string[0], phase + "_part_" + index);
        }
        Dependencies(AssemblyDoc, Parts, phase + "_assembly");
        Scope(); Need(Documents.Count == 3 && found.Count == 2, "private_three_document_closure");
    }
    static void SaveDocument(IModelDoc2 model, string path, string phase)
    {
        Scope(); Need(PathEqual(model.GetPathName(), path) && !model.IsOpenedReadOnly(), "exact_writable_save_target");
        int errors = 0, warnings = 0;
        bool saved;
#if OVD_QUALIFY_NATIVE_CALL
        using (QualifyNativeSave(model, path, phase))
#endif
        { saved = Call("Save3", () => model.Save3(1, ref errors, ref warnings)); }
        Report[phase] = new { saved = saved, errors = errors, warnings = warnings, path = model.GetPathName(), dirty = model.GetSaveFlag() };
        Need(saved && errors == 0 && warnings == 0 && !model.GetSaveFlag() && PathEqual(model.GetPathName(), path), phase);
    }
    static void ClosePackage()
    {
        Scope(); string[] ordered = { AssemblyPath, Parts[0], Parts[1] };
        foreach (string path in ordered) {
            var actual = Loaded(); IModelDoc2 target = null;
            foreach (IModelDoc2 model in actual) if (PathEqual(model.GetPathName(), path)) target = model;
            if (target == null) continue; // Closing the assembly can unload a referenced part.
            Scope(); string title = target.GetTitle(); int titleMatches = 0;
            foreach (IModelDoc2 model in actual) if (model.GetTitle() == title) titleMatches++;
            Need(titleMatches == 1, "unique_close_title");
            Call("CloseDoc", () => { Sw.CloseDoc(title); return true; });
            var remaining = Loaded();
            foreach (IModelDoc2 model in remaining) {
                Need(!Same(model, target), "closed_exact_document");
                bool known = false; foreach (IModelDoc2 prior in Documents) if (Same(model, prior)) known = true;
                Need(known, "remaining_known_document");
            }
            Documents = remaining;
        }
        Need(Sw.GetDocumentCount() == 0 && Documents.Count == 0, "closed_package_empty");
        AssemblyDoc = null; PartDocs = new IModelDoc2[2]; ReleaseOwned();
        Need(ReleaseErrors.Count == 0, "document_references_released");
    }
    static void ExecutePackage()
    {
        LoadPackage(ExpectedDepth, true, "before"); ClosePackage(); CheckInitialFiles();
        IModelDoc2 target = OpenPrivate(Parts[0], 1, false, "edit_target");
        var before = MeasurePart(target, ExpectedDepth, "before_dimension");
        EditPart(target); MeasurePart(target, TargetDepth, "after_edit");
        SaveDocument(target, Parts[0], "part_save"); ClosePackage();
        string editedHash = Hash(Parts[0]); Need(TargetDepth == ExpectedDepth || editedHash != InputHashes[1], "changed_target_file");
        target = OpenPrivate(Parts[0], 1, true, "saved_part_reopen");
        var after = MeasurePart(target, TargetDepth, "after_dimension"); ClosePackage();
        Need(Hash(Parts[0]) == editedHash && Hash(Parts[1]) == InputHashes[2], "part_reopen_preserved");
        LoadPackage(TargetDepth, false, "updated");
        ActivateAssembly(); SaveDocument(AssemblyDoc, AssemblyPath, "assembly_save"); ClosePackage();
        string savedAssemblyHash = Hash(AssemblyPath);
        Need(Hash(Parts[0]) == editedHash && Hash(Parts[1]) == InputHashes[2], "assembly_save_preserved_parts");
        LoadPackage(TargetDepth, true, "final_reopen"); ClosePackage();
        Need(Hash(AssemblyPath) == savedAssemblyHash && Hash(Parts[0]) == editedHash &&
            Hash(Parts[1]) == InputHashes[2], "final_readonly_reopen_preserved");
        Report["measurements"] = new { beforeDepthMm = before["depthMm"], afterDepthMm = after["depthMm"],
            beforeVolumeMm3 = before["volumeMm3"], afterVolumeMm3 = after["volumeMm3"] };
        Report["verifiedChecks"] = new[] { "native_integrity", "dimension", "assembly_references", "component_placements", "save_reopen" };
    }
}
