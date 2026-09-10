using System;
using System.Collections.Generic;
using System.IO;
using SolidWorks.Interop.sldworks;

// Read-only adapter over the qualified prepared-package measurements. Compiled with
// /main:NativeSessionProbe: the dimension-editing entry point is never dispatched.
partial class PreparedDimensionProbe
{
    internal static Dictionary<string, object> InspectRecovery(ISldWorks application, string path,
        bool open, bool close, int pid, long ticks, int session)
    {
        Report.Clear(); Checks.Clear(); ReleaseErrors.Clear();
        Report["outcome"] = "failed"; Report["checks"] = Checks; Report["releaseErrors"] = ReleaseErrors;
        Report["verified"] = false; Report["readOnly"] = false;
        ExpectedPid = pid; ExpectedTicks = ticks; ExpectedSession = session; Sw = application;
        try {
            Need(Path.IsPathRooted(path), "absolute_assembly_path");
            AssemblyPath = Path.GetFullPath(path); Package = Path.GetDirectoryName(AssemblyPath);
            Need(Package.Length <= 140 && Path.GetFileName(AssemblyPath) == "synthetic-assembly.SLDASM", "prepared_assembly_path");
            Parts = new[] { Path.Combine(Package, "parts", "baseline-5mm.SLDPRT"),
                Path.Combine(Package, "parts", "candidate-8mm.SLDPRT") };
            Report["path"] = AssemblyPath;
            Documents = new List<IModelDoc2>(); PartDocs = new IModelDoc2[2];
            NativeIdentity(); CheckInitialFiles();
            if (open) {
                Need(Sw.GetDocumentCount() == 0, "initial_empty_ready");
                LoadPackage(.005, true, "recovery");
            } else {
                BindRecoveryDocuments();
                MeasurePart(PartDocs[0], .005, "recovery_geometry_0");
                MeasurePart(PartDocs[1], .008, "recovery_geometry_1");
                InspectAssembly("recovery");
            }
            Scope();
            foreach (IModelDoc2 model in Documents) Need(model.IsOpenedReadOnly(), "all_documents_readonly");
            Report["readOnly"] = true;
            if (close) ClosePackage();
            CheckInitialFiles(); NativeIdentity();
            int expectedCount = 3; if (close) expectedCount = 0;
            Report["documentCountAfter"] = Sw.GetDocumentCount();
            Need((int)Report["documentCountAfter"] == expectedCount, "final_recovery_document_count");
            Report["outcome"] = "passed"; Report["verified"] = true;
        } catch (Exception error) {
            Report["error"] = error.Message;
            throw;
        } finally {
            // Release this helper's RCWs only. Failure never closes or saves documents.
            ReleaseOwned(); Sw = null;
            if (ReleaseErrors.Count != 0) {
                Report["outcome"] = "failed"; Report["verified"] = false;
                throw new InvalidOperationException("Assembly recovery reference cleanup failed.");
            }
        }
        return Report;
    }

    internal static Dictionary<string, object> RecoveryReport { get { return Report; } }

    // Reacquire by exact loaded private paths, then compare native object identity
    // and reference closure. Never reopen an unknown or missing document here.
    static void BindRecoveryDocuments()
    {
        Documents = Loaded(); Need(Documents.Count == 3, "existing_three_documents");
        AssemblyDoc = null;
        foreach (IModelDoc2 model in Documents) {
            string path = model.GetPathName();
            Need(model.IsOpenedReadOnly() && Config(model) == "Default", "existing_readonly_default");
            if (PathEqual(path, AssemblyPath)) {
                Need(AssemblyDoc == null && model.GetType() == 2, "unique_existing_assembly"); AssemblyDoc = model;
            } else {
                int index = -1;
                if (PathEqual(path, Parts[0])) index = 0; else if (PathEqual(path, Parts[1])) index = 1;
                Need(index >= 0 && model.GetType() == 1, "known_existing_part");
                Need(PartDocs[index] == null, "unique_existing_part"); PartDocs[index] = model;
            }
        }
        Need(AssemblyDoc != null && PartDocs[0] != null && PartDocs[1] != null, "complete_existing_closure");
        Scope();
    }
}
