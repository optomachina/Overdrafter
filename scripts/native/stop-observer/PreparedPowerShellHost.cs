using System;
using System.Collections;
using System.Globalization;
using System.IO;
using System.Management.Automation;
using System.Management.Automation.Host;
using System.Management.Automation.Runspaces;
using System.Security.Cryptography;
using System.Text.RegularExpressions;
using System.Threading;

namespace OverDrafter.StopObserver {
    // One trusted, pinned prepared script. Compile as WindowsApplication before
    // job observation; the PowerShell engine needs no ConsoleHost process.
    public static class PreparedPowerShellHost {
        private sealed class Host : PSHost {
            private readonly Guid id=Guid.NewGuid();
            public bool ExitRequested, PolicyFailed;
            public int ExitCode;
            public override Guid InstanceId { get { return id; } }
            public override string Name { get { return "OverDrafter.PreparedPowerShellHost"; } }
            public override Version Version { get { return new Version(1,0); } }
            public override CultureInfo CurrentCulture { get { return CultureInfo.InvariantCulture; } }
            public override CultureInfo CurrentUICulture { get { return CultureInfo.InvariantCulture; } }
            // Null UI is the supported noninteractive hosting contract.
            public override PSHostUserInterface UI { get { return null; } }
            public override void SetShouldExit(int code) { ExitRequested=true; ExitCode=code; }
            private void Deny() { PolicyFailed=true; throw new NotSupportedException("Prepared host requires noninteractive owned launches."); }
            public override void EnterNestedPrompt() { Deny(); }
            public override void ExitNestedPrompt() { Deny(); }
            // Notifications are not universal (redirected commands can bypass
            // them). Script admission and independent accounting own scope.
            public override void NotifyBeginApplication() { }
            public override void NotifyEndApplication() { }
        }
        private static Hashtable Parameters(string[] arguments) {
            var values=new Hashtable(StringComparer.OrdinalIgnoreCase);
            int characters=0;
            foreach (string argument in arguments) characters+=argument.Length;
            if (characters > 28000 || arguments.Length > 66) throw new ArgumentException("Prepared host argument bound exceeded.");
            for (int i=2;i<arguments.Length;i++) {
                string token=arguments[i];
                if (token.Length < 2 || (token[0] != '-' && token[0] != '+')) throw new ArgumentException("Expected named prepared parameter.");
                string name=token.Substring(1);
                if (!Regex.IsMatch(name,"^[A-Za-z][A-Za-z0-9]{0,63}$") || values.ContainsKey(name) || values.Count >= 32)
                    throw new ArgumentException("Invalid or duplicate prepared parameter.");
                if (token[0] == '+') values.Add(name,new SwitchParameter(true));
                else {
                    if (++i >= arguments.Length) throw new ArgumentException("Missing prepared parameter value.");
                    values.Add(name,arguments[i]);
                }
            }
            return values;
        }
        // Keep the exact hashed file open without write/delete sharing through
        // invocation. The trusted caller separately pins imported runtime files.
        private static FileStream OpenScript(string path,string expected) {
            if (!Regex.IsMatch(path,@"^[A-Za-z]:\\") || path.IndexOf(':',2) >= 0 || !Regex.IsMatch(expected,"^[a-f0-9]{64}$")) throw new ArgumentException("Expected absolute pinned script.");
            var stream=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.Read);
            try {
                if (stream.Length > 1048576) throw new ArgumentException("Prepared script outside size bound.");
                using (var hash=SHA256.Create()) {
                    string actual=BitConverter.ToString(hash.ComputeHash(stream)).Replace("-","").ToLowerInvariant();
                    if (!String.Equals(actual,expected,StringComparison.Ordinal)) throw new ArgumentException("Prepared script hash differs.");
                }
                return stream;
            } catch { stream.Dispose(); throw; }
        }
        // Prepared results use the success/error streams. Drain informational
        // streams too so a long-running script cannot accumulate host buffers.
        private static void Drain<T>(PSDataCollection<T> stream) {
            stream.DataAdded+=(sender,args)=> { stream.ReadAll(); };
        }
        private static int Run(string path,Hashtable parameters) {
            var host=new Host(); bool errors=false, ioFailed=false;
            using (var runspace=RunspaceFactory.CreateRunspace(host))
            using (var shell=PowerShell.Create())
            using (var output=new PSDataCollection<PSObject>()) {
                runspace.ApartmentState=ApartmentState.STA;
                runspace.ThreadOptions=PSThreadOptions.UseCurrentThread;
                runspace.Open(); shell.Runspace=runspace;
                var versions=runspace.SessionStateProxy.GetVariable("PSVersionTable") as Hashtable;
                var version=versions == null ? null : versions["PSVersion"] as Version;
                if (version == null || version.Major != 5 || version.Minor != 1)
                    throw new NotSupportedException("Prepared host requires Windows PowerShell 5.1.");
                // Global scope preserves journal callbacks' shared functions;
                // both path and parameter values are objects, never source text.
                // A dot-sourced file records exit in LASTEXITCODE rather than
                // requesting host exit. Propagate it from the outer pipeline.
                shell.AddScript("param($entryPath,$entryParameters) $global:LASTEXITCODE=0; . $entryPath @entryParameters; exit $global:LASTEXITCODE",false)
                    .AddArgument(path).AddArgument(parameters);
                output.DataAdded+=(sender,args)=> {
                    try { foreach (var item in output.ReadAll()) Console.Out.WriteLine(item.ToString()); }
                    catch { ioFailed=true; throw; }
                };
                shell.Streams.Error.DataAdded+=(sender,args)=> {
                    errors=true;
                    try { foreach (var error in shell.Streams.Error.ReadAll()) Console.Error.WriteLine(error.ToString()); }
                    catch { ioFailed=true; throw; }
                };
                Drain(shell.Streams.Debug); Drain(shell.Streams.Verbose);
                Drain(shell.Streams.Warning); Drain(shell.Streams.Information);
                Drain(shell.Streams.Progress);
                try { shell.Invoke<PSObject,PSObject>(null,output,null); }
                catch (PipelineStoppedException) { if (!host.ExitRequested) throw; }
                if (host.PolicyFailed || ioFailed) return 1;
                if (host.ExitRequested && host.ExitCode != 0) return host.ExitCode;
                if (errors || shell.HadErrors) return 1;
                return 0;
            }
        }
        [STAThread]
        public static int Main(string[] arguments) {
            try {
                if (arguments.Length < 2)
                    throw new ArgumentException("Prepared host requires Windows PowerShell 5.1 and pinned script arguments.");
                var parameters=Parameters(arguments);
                // Reject drive-relative, root-relative, UNC and device paths before
                // resolving once for both hashing and runspace invocation.
                if (!Regex.IsMatch(arguments[0],@"^[A-Za-z]:\\")) throw new ArgumentException("Expected fully qualified local script.");
                string path=Path.GetFullPath(arguments[0]);
                using (OpenScript(path,arguments[1])) return Run(path,parameters);
            } catch (Exception error) { Console.Error.WriteLine(error.Message); return 1; }
        }
    }
}
