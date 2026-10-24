using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.ExceptionServices;
using System.Runtime.InteropServices;
using SolidWorks.Interop.sldworks;

// Read-only extraction from native04 Fixture.cs (313248ef...) and proven
// PartVerification.cs (b155bc99...). Caller supplies an already authorized private copy.
// Single-STA qualification helper; LastReport is partial evidence, not durable state.
internal static class PreparedCylinder
{
    internal static Dictionary<string, object> LastReport;

    internal static Dictionary<string, object> Inspect(ISldWorks sw, string path, bool open, bool close, Action nativeGuard)
    {
        LastReport = new Dictionary<string, object> {
            {"outcome", "in_progress"}, {"path", null}, {"requestedPath", path}, {"verified", false}, {"openRequested", open},
            {"closeRequested", false}, {"readOnly", false}, {"documentCountAfter", null}
        };
        var inspection = new Inspection(sw, path, nativeGuard, LastReport);
        Exception failure = null;
        try { inspection.Run(open, close); }
        catch (Exception error) {
            failure = error; LastReport["error"] = error.Message;
            LastReport["hresult"] = "0x" + error.HResult.ToString("X8");
        }
        finally { inspection.ReleaseAll(); }
        if (inspection.ReleaseErrors.Count > 0) {
            LastReport["outcome"] = "failed";
            var errors = new List<Exception>(inspection.ReleaseErrors);
            if (failure != null) errors.Insert(0, failure);
            throw new AggregateException("Prepared cylinder reference cleanup failed.", errors);
        }
        if (failure != null) {
            LastReport["outcome"] = "failed";
            ExceptionDispatchInfo.Capture(failure).Throw();
        }
        LastReport["outcome"] = "passed";
        LastReport["verified"] = true;
        return LastReport;
    }

    private sealed class Inspection
    {
        const string Digest = "e4ff1efb9ead3efd44ad24262dee670bee7de82a894ea0a0d998a58a3fd8b8aa";
        const string FeatureName = "OVD_QualificationExtrusion";
        readonly ISldWorks sw;
        readonly string path;
        readonly Action nativeGuard;
        readonly Dictionary<string, object> report;
        readonly Dictionary<string, object> checks = new Dictionary<string, object>();
        readonly List<object> owned = new List<object>();
        readonly List<IntPtr> pins = new List<IntPtr>();
        readonly List<string> releaseMessages = new List<string>();
        internal readonly List<Exception> ReleaseErrors = new List<Exception>();
        IModelDoc2 model;
        IntPtr modelIdentity;

        internal Inspection(ISldWorks application, string file, Action guard, Dictionary<string, object> result)
        {
            sw = application; path = file; nativeGuard = guard; report = result;
            report["checks"] = checks; report["releaseErrors"] = releaseMessages;
        }

        void Need(bool condition, string stage)
        {
            checks[stage] = condition;
            if (!condition) { report["stage"] = stage; throw new InvalidOperationException(stage); }
        }

        T Call<T>(string stage, Func<T> operation)
        {
            report["stage"] = stage;
            return operation();
        }

        // Each returned RCW acquisition is retained, including repeated object identity.
        T Own<T>(string stage, Func<object> operation) where T : class
        {
            object value = Call(stage, operation);
            if (value != null && Marshal.IsComObject(value)) owned.Add(value);
            return (T)value;
        }

        IntPtr Pin(object value)
        {
            IntPtr pin = Marshal.GetIUnknownForObject(value);
            pins.Add(pin);
            return pin;
        }

        void FileCheck(string stage)
        {
            Need(!String.IsNullOrEmpty(path) && Path.IsPathRooted(path), "absolute_private_path");
            Need(File.Exists(path), stage + "_exists");
            Need(SharedFilePredicates.MatchesFile(path, 56144, Digest), stage + "_bytes_hash");
            report["sha256"] = Digest; report["bytes"] = 56144;
        }

        // The application is borrowed; only references acquired here are released.
        void Guard()
        {
            nativeGuard();
            Need(sw.GetDocumentCount() == 1 && model != null, "sole_document");
            IModelDoc2 current = Own<IModelDoc2>("GetFirstDocument.guard", () => sw.GetFirstDocument());
            Need(current != null && Pin(current) == modelIdentity, "same_document_identity");
            Need(model.GetType() == 1 && SharedFilePredicates.PathEqual(model.GetPathName(), path), "exact_part_path");
            Need(model.IsOpenedReadOnly(), "readonly");
        }

        void Acquire(bool open)
        {
            nativeGuard();
            int before = sw.GetDocumentCount(); report["documentCountBefore"] = before;
            if (open) {
                Need(before == 0, "empty_before_open");
                int errors = 0, warnings = 0;
                try { model = Own<IModelDoc2>("OpenDoc6", () => sw.OpenDoc6(path, 1, 3, "Default", ref errors, ref warnings)); }
                finally { report["openErrors"] = errors; report["openWarnings"] = warnings; report["openOptions"] = 3; }
                Need(model != null && errors == 0 && warnings == 0, "strict_open_result");
            } else {
                Need(before == 1, "sole_before_acquire");
                model = Own<IModelDoc2>("GetFirstDocument.acquire", () => sw.GetFirstDocument());
                Need(model != null, "existing_document");
            }
            modelIdentity = Pin(model);
            report["identity"] = modelIdentity.ToInt64().ToString("X");
            Guard();
            report["path"] = model.GetPathName(); report["readOnly"] = model.IsOpenedReadOnly();
        }

        void InspectContext()
        {
            Guard();
            int count = model.GetConfigurationCount(); report["configurationCount"] = count;
            var manager = Own<IConfigurationManager>("ConfigurationManager", () => model.ConfigurationManager);
            var configuration = Own<IConfiguration>("ActiveConfiguration", () => manager.ActiveConfiguration);
            Need(configuration != null, "configuration_present");
            string name = configuration.Name; report["configuration"] = name;
            Need(count == 1 && name == "Default", "only_default_configuration");
            object sketch = Own<object>("GetActiveSketch", () => model.GetActiveSketch());
            Need(sketch == null, "no_active_sketch");
            var extension = Own<IModelDocExtension>("Extension", () => model.Extension);
            object raw = Own<object>("GetDependencies", () => extension.GetDependencies(true, false, false, true, true));
            var dependencies = raw as Array;
            Need(raw == null || dependencies != null, "dependency_array");
            int dependencyCount = 0;
            if (dependencies != null) dependencyCount = dependencies.Length;
            report["dependencyEntries"] = dependencyCount;
            Need(dependencyCount == 0, "no_dependencies");
        }

        void Walk(IFeature first, bool subchain, List<IFeature> features, HashSet<long> seen, HashSet<long> active)
        {
            var chain = new HashSet<long>();
            IFeature feature = first;
            while (feature != null) {
                long identity = Pin(feature).ToInt64();
                Need(chain.Add(identity) && !active.Contains(identity), "no_feature_cycle");
                if (seen.Add(identity)) {
                    Need(features.Count < 100, "feature_bound");
                    features.Add(feature); active.Add(identity);
                    IFeature child = Own<IFeature>("GetFirstSubFeature", () => feature.GetFirstSubFeature());
                    if (child != null) Walk(child, true, features, seen, active);
                    active.Remove(identity);
                }
                IFeature prior = feature;
                if (subchain) feature = Own<IFeature>("GetNextSubFeature", () => prior.GetNextSubFeature());
                else feature = Own<IFeature>("GetNextFeature", () => prior.GetNextFeature());
            }
        }

        IFeature BindFeature()
        {
            Guard();
            var features = new List<IFeature>();
            Walk(Own<IFeature>("FirstFeature", () => model.FirstFeature()), false,
                features, new HashSet<long>(), new HashSet<long>());
            IFeature found = null; int matches = 0;
            foreach (IFeature feature in features) {
                if (feature.Name == FeatureName && feature.GetTypeName2() == "Extrusion") { found = feature; matches++; }
            }
            report["featureCount"] = features.Count;
            Need(matches == 1, "unique_extrusion");
            report["featureName"] = found.Name; report["featureType"] = found.GetTypeName2();
            return found;
        }

        object[] Bodies(int kind)
        {
            object raw = Own<object>("GetBodies2." + kind, () => ((IPartDoc)model).GetBodies2(kind, false));
            if (raw == null) return new object[0];
            object[] bodies = raw as object[];
            Need(bodies != null, "body_array");
            foreach (object body in bodies) {
                if (body != null && Marshal.IsComObject(body)) owned.Add(body);
            }
            return bodies;
        }

        void Measure(IFeature feature)
        {
            Guard();
            var data = Own<IExtrudeFeatureData2>("GetDefinition", () => feature.GetDefinition());
            Need(data != null, "extrusion_definition");
            var values = new Dictionary<string, object>(); report["measurements"] = values;
            bool isBase = feature.IsBase2(); values["isBase"] = isBase;
            bool isBoss = data.IsBossFeature(); values["isBossDiagnostic"] = isBoss;
            bool thin = data.IsThinFeature(); values["isThin"] = thin;
            bool both = data.BothDirections; values["bothDirections"] = both;
            double depth = data.GetDepth(true); values["depthM"] = depth;
            int end = data.GetEndCondition(true); values["endCondition"] = end;
            int from = data.FromType; values["fromType"] = from;
            bool reverse = data.ReverseDirection; values["reverseDirection"] = reverse;
            Guard();
            bool rebuild = Call("ForceRebuild3", () => model.ForceRebuild3(false)); values["rebuild"] = rebuild;
            bool warning = false;
            int error = feature.GetErrorCode2(out warning); values["featureError"] = error; values["featureWarning"] = warning;
            Guard();
            object[] solids = Bodies(0), sheets = Bodies(1);
            values["solidBodies"] = solids.Length; values["sheetBodies"] = sheets.Length;
            Need(solids.Length == 1 && solids[0] != null && sheets.Length == 0, "body_counts");
            Guard();
            double[] mass = Call<object>("GetMassProperties", () => ((IBody2)solids[0]).GetMassProperties(1.0)) as double[];
            values["massProperties"] = mass; values["testDensity"] = 1.0;
            Need(mass != null && mass.Length >= 12, "mass_array");
            foreach (double value in mass) Need(Finite(value), "finite_mass_properties");
            double volume = Math.PI * .010 * .010 * .005, area = 2 * Math.PI * .010 * (.010 + .005);
            values["volumeM3"] = mass[3]; values["areaM2"] = mass[4];
            values["centerM"] = new double[] {mass[0], mass[1], mass[2]};
            Need(isBase && !thin && !both && end == 0 && from == 0 && !reverse &&
                Finite(depth) && Math.Abs(depth - .005) <= 1e-10 &&
                feature.Name == FeatureName && feature.GetTypeName2() == "Extrusion", "extrusion_semantics");
            Need(rebuild && error == 0 && !warning, "native_rebuild");
            Need(Math.Abs(mass[3] - volume) <= 1e-10 && Math.Abs(mass[4] - area) <= 1e-9 &&
                Math.Abs(mass[0]) <= 1e-8 && Math.Abs(mass[1]) <= 1e-8 &&
                Math.Abs(mass[2] - .0025) <= 1e-8, "geometry");
        }

        static bool Finite(double value) { return !Double.IsNaN(value) && !Double.IsInfinity(value); }

        internal void Run(bool open, bool close)
        {
            Need(sw != null && nativeGuard != null, "caller_context");
            FileCheck("input"); Acquire(open); InspectContext(); Measure(BindFeature());
            Guard(); FileCheck("verified");
            if (close) {
                string title = model.GetTitle();
                ReleaseAll();
                Need(ReleaseErrors.Count == 0, "references_released_before_close");
                nativeGuard(); Need(sw.GetDocumentCount() == 1, "sole_before_close");
                report["closeRequested"] = true;
                Call("CloseDoc", () => { sw.CloseDoc(title); return true; });
                nativeGuard(); int after = sw.GetDocumentCount(); report["documentCountAfter"] = after;
                Need(after == 0, "closed_empty"); FileCheck("closed");
            } else { report["documentCountAfter"] = sw.GetDocumentCount(); Need((int)report["documentCountAfter"] == 1, "left_open"); }
        }

        // One release per acquired IUnknown pin and returned RCW count, never final release.
        internal void ReleaseAll()
        {
            model = null;
            foreach (IntPtr pin in pins) {
                try { Marshal.Release(pin); } catch (Exception error) { RecordRelease(error); }
            }
            pins.Clear();
            for (int index = owned.Count - 1; index >= 0; index--) {
                try { Marshal.ReleaseComObject(owned[index]); } catch (Exception error) { RecordRelease(error); }
            }
            owned.Clear();
        }

        void RecordRelease(Exception error)
        {
            ReleaseErrors.Add(error);
            releaseMessages.Add(error.Message + ":0x" + error.HResult.ToString("X8"));
        }
    }
}
