using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using SolidWorks.Interop.sldworks;

partial class PreparedDimensionProbe
{
    const string FeatureName = "OVD_QualificationExtrusion";
    static bool Finite(double value) { return !Double.IsNaN(value) && !Double.IsInfinity(value); }

    // The bounded cycle-aware walk preserves repeated feature identities without
    // mistaking a repeated subfeature reference for a true traversal cycle.
    static void WalkFeatures(IFeature first, bool subchain, List<IFeature> found,
        HashSet<long> seen, HashSet<long> active)
    {
        var chain = new HashSet<long>();
        IFeature feature = first;
        while (feature != null) {
            IntPtr pin = Marshal.GetIUnknownForObject(feature);
            long identity;
            try { identity = pin.ToInt64(); } finally { Marshal.Release(pin); }
            Need(chain.Add(identity) && !active.Contains(identity), "feature_cycle");
            if (seen.Add(identity)) {
                Need(found.Count < 100, "feature_bound"); found.Add(feature); active.Add(identity);
                IFeature child = Own<IFeature>("GetFirstSubFeature", () => feature.GetFirstSubFeature());
                if (child != null) WalkFeatures(child, true, found, seen, active);
                active.Remove(identity);
            }
            IFeature prior = feature;
            if (subchain) feature = Own<IFeature>("GetNextSubFeature", () => prior.GetNextSubFeature());
            else feature = Own<IFeature>("GetNextFeature", () => prior.GetNextFeature());
        }
    }
    static IFeature BindFeature(IModelDoc2 model)
    {
        var features = new List<IFeature>();
        WalkFeatures(Own<IFeature>("FirstFeature", () => model.FirstFeature()), false, features,
            new HashSet<long>(), new HashSet<long>());
        IFeature found = null; int matches = 0;
        foreach (IFeature feature in features) {
            if (feature.Name == FeatureName && feature.GetTypeName2() == "Extrusion") { found = feature; matches++; }
        }
        Need(matches == 1, "unique_driving_extrusion");
        return found;
    }
    static object[] Bodies(IModelDoc2 model, int kind)
    {
        object raw = Call<object>("GetBodies2", () => ((IPartDoc)model).GetBodies2(kind, false));
        if (raw == null) return new object[0];
        object[] values = raw as object[]; Need(values != null, "body_array");
        foreach (object value in values) if (value != null && Marshal.IsComObject(value)) Owned.Add(value);
        return values;
    }
    static Dictionary<string, object> MeasurePart(IModelDoc2 model, double height, string phase)
    {
        Scope(); Need(model.GetType() == 1 && Config(model) == "Default", phase + "_part_context");
        Dependencies(model, new string[0], phase);
        Need(Own<object>("GetActiveSketch", () => model.GetActiveSketch()) == null, "no_active_sketch");
        IFeature feature = BindFeature(model);
        var data = Own<IExtrudeFeatureData2>("GetDefinition", () => feature.GetDefinition());
        Need(data != null, "extrusion_definition");
        double depth = data.GetDepth(true);
        var values = new Dictionary<string, object> {
            {"depthM", depth}, {"isBase", feature.IsBase2()}, {"isBossDiagnostic", data.IsBossFeature()},
            {"thin", data.IsThinFeature()}, {"bothDirections", data.BothDirections},
            {"endCondition", data.GetEndCondition(true)}, {"fromType", data.FromType}, {"reverse", data.ReverseDirection}
        };
        Report[phase] = values;
        Need((bool)values["isBase"] && !(bool)values["thin"] && !(bool)values["bothDirections"] &&
            (int)values["endCondition"] == 0 && (int)values["fromType"] == 0 && !(bool)values["reverse"] &&
            Finite(depth) && Math.Abs(depth - height) <= 1e-10, phase + "_extrusion_semantics");
        Scope(); bool rebuild = Call("part.ForceRebuild3", () => model.ForceRebuild3(false));
        bool warning = false; int error = feature.GetErrorCode2(out warning);
        values["rebuild"] = rebuild; values["featureError"] = error; values["featureWarning"] = warning;
        Need(rebuild && error == 0 && !warning, phase + "_native_rebuild");
        object[] solids = Bodies(model, 0), sheets = Bodies(model, 1);
        Need(solids.Length == 1 && solids[0] != null && sheets.Length == 0, phase + "_body_counts");
        double[] mass = Call<object>("GetMassProperties", () => ((IBody2)solids[0]).GetMassProperties(1.0)) as double[];
        values["massProperties"] = mass; values["testDensity"] = 1;
        Need(mass != null && mass.Length >= 12, "mass_array");
        foreach (double value in mass) Need(Finite(value), "finite_mass_properties");
        double volume = Math.PI * .010 * .010 * height, area = 2 * Math.PI * .010 * (.010 + height);
        Need(Math.Abs(mass[3] - volume) <= 1e-10 && Math.Abs(mass[4] - area) <= 1e-9 &&
            Math.Abs(mass[0]) <= 1e-8 && Math.Abs(mass[1]) <= 1e-8 && Math.Abs(mass[2] - height / 2) <= 1e-8,
            phase + "_cylinder_geometry");
        values["volumeMm3"] = mass[3] * 1e9; values["depthMm"] = depth * 1000;
        Scope(); return values;
    }
    static void EditPart(IModelDoc2 model)
    {
        Scope(); Need(Documents.Count == 1 && PathEqual(model.GetPathName(), Parts[0]) &&
            !model.IsOpenedReadOnly(), "sole_private_writable_target");
        IFeature feature = BindFeature(model);
        var data = Own<IExtrudeFeatureData2>("edit.GetDefinition", () => feature.GetDefinition());
        Need(data != null, "edit_extrusion_definition");
        bool access = false, modified = false;
        try {
            Scope(); access = Call("AccessSelections", () => data.AccessSelections(model, null)); Need(access, "edit_selection_access");
            Scope(); Call("SetDepth", () => { data.SetDepth(true, TargetDepth); return true; });
            Scope(); modified = Call("ModifyDefinition", () => feature.ModifyDefinition(data, model, null));
            Need(modified, "dimension_modified");
        } finally {
            if (access && !modified) Call("ReleaseSelectionAccess", () => { data.ReleaseSelectionAccess(); return true; });
        }
    }
}
