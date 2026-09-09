using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Threading;
using System.Web.Script.Serialization;

// Experimental typed probe for one explicitly identified, empty native session.
// Connecting to a registered COM object does not establish process ownership;
// the supervisor separately retains the process it directly starts.
class NativeSessionProbe {
 const string Exe = @"C:\Program Files\SOLIDWORKS 2022\SOLIDWORKS\SLDWORKS.exe";
 const string Digest = "6384c0829bac149831be5fdc9e705c90612273d25b46fdff5e5760d11e22d6cc";
 static readonly Dictionary<string,object> R = new Dictionary<string,object>();
 static void Need(bool ok, string why) { if (!ok) throw new InvalidOperationException(why); }
 static void Record(string stage) {
  R["stage"] = stage;
  Console.Error.WriteLine(new JavaScriptSerializer().Serialize(R)); Console.Error.Flush();
 }
 // Only read-only startup observations may be retried. Identity and document
 // failures stay terminal, and a shutdown request is never retried here.
 static bool IsStartupPending(string[] args, Exception error) {
  if (args.Length != 4 || args[0] != "inspect" || !R.ContainsKey("stage") || R.ContainsKey("releaseError")) return false;
  if ((string)R["stage"] != "bind_existing") return false;
  if (error is COMException && error.HResult == unchecked((int)0x800401E3)) return true;
  return error is InvalidOperationException && error.Message == "startup_not_complete";
 }
 static void Guard(int pid, long ticks, int session) {
  Process[] all = Process.GetProcessesByName("SLDWORKS");
  try {
   Need(all.Length == 1, "singleton_mismatch");
   Process p = all[0];
   Need(p.Id == pid && p.SessionId == session &&
    session == Process.GetCurrentProcess().SessionId &&
    p.StartTime.ToUniversalTime().Ticks == ticks, "process_identity_mismatch");
   Need(String.Equals(p.MainModule.FileName, Exe, StringComparison.OrdinalIgnoreCase), "path_mismatch");
   var v = p.MainModule.FileVersionInfo;
   Need(v.FileVersion == "30.5.0.0049" && v.ProductVersion == "30.5.0.0049", "version_mismatch");
   using (var f = File.OpenRead(Exe)) using (var h = SHA256.Create())
    Need(BitConverter.ToString(h.ComputeHash(f)).Replace("-","").ToLowerInvariant() == Digest, "hash_mismatch");
  } finally { foreach (Process p in all) p.Dispose(); }
 }
 [STAThread] static int Main(string[] args) {
  AppDomain.CurrentDomain.AssemblyResolve += delegate(object sender, ResolveEventArgs e) {
   return new AssemblyName(e.Name).Name == "SolidWorks.Interop.sldworks"
    ? Assembly.LoadFrom(@"C:\Program Files\SOLIDWORKS 2022\SOLIDWORKS\api\redist\SolidWorks.Interop.sldworks.dll") : null;
  };
  R["utc"] = DateTime.UtcNow.ToString("o"); R["helperPid"] = Process.GetCurrentProcess().Id;
  R["outcome"] = "failed"; R["exitAppRequested"] = false;
  try {
   Need(args.Length == 4, "arguments");
   Need(args[0] == "inspect" || args[0] == "graceful-close-empty", "mode");
   int pid = Int32.Parse(args[1]); long ticks = Int64.Parse(args[2]); int session = Int32.Parse(args[3]);
   R["mode"] = args[0]; R["expectedPid"] = pid; R["expectedTicks"] = ticks.ToString(); R["session"] = session;
   Need(Thread.CurrentThread.GetApartmentState() == ApartmentState.STA, "STA");
   Guard(pid,ticks,session); Run(args[0],pid,ticks,session); R["outcome"] = "passed";
  } catch (Exception e) {
   R["error"] = e.Message; R["hresult"] = "0x"+e.HResult.ToString("X8");
   if (IsStartupPending(args,e)) R["outcome"] = "not_ready";
  }
  Console.WriteLine(new JavaScriptSerializer().Serialize(R));
  if ((string)R["outcome"] == "passed") return 0;
  if ((string)R["outcome"] == "not_ready") return 3;
  return 2;
 }
 [MethodImpl(MethodImplOptions.NoInlining)]
 static void Run(string mode, int pid, long ticks, int session) {
  Need(typeof(SolidWorks.Interop.sldworks.ISldWorks).Assembly.GetName().Version.ToString() == "30.5.0.49" &&
   typeof(SolidWorks.Interop.sldworks.ISldWorks).GUID == new Guid("83A33D22-27C5-11CE-BFD4-00400513BB57"), "interop");
  object raw = null;
  try {
   Record("bind_existing");
   raw = Marshal.GetActiveObject("SldWorks.Application.30");
   var sw = (SolidWorks.Interop.sldworks.ISldWorks)raw;
   int actual = sw.GetProcessID(); string revision = sw.RevisionNumber();
   R["apiPid"] = actual; R["revision"] = revision;
   Need(actual == pid && revision == "30.5.0", "api_identity_mismatch");
   bool startupCompleted = sw.StartupProcessCompleted;
   R["startupCompleted"] = startupCompleted;
   Need(startupCompleted, "startup_not_complete");
   int docs = sw.GetDocumentCount(); R["documentCount"] = docs; Need(docs == 0, "documents_not_empty");
   Guard(pid,ticks,session);
   if (mode == "graceful-close-empty") {
    Record("before_final_empty_identity_check");
    Need(sw.GetProcessID() == pid && sw.RevisionNumber() == "30.5.0", "final_api_identity");
    Need(sw.GetDocumentCount() == 0, "final_documents_not_empty");
    R["exitAppRequested"] = true; Record("exit_app_request");
    sw.ExitApp(); Record("exit_app_returned");
   } else {
    Need(sw.GetProcessID() == pid && sw.GetDocumentCount() == 0, "final_inspect_mismatch");
    Record("inspected_empty");
   }
  } finally {
   if (raw != null && Marshal.IsComObject(raw)) {
    try { Marshal.ReleaseComObject(raw); }
    catch (Exception e) { R["releaseError"] = e.Message; throw; }
   }
  }
 }
}
