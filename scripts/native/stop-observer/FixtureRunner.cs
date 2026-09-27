using System;
using System.IO;
using System.Management.Automation;

// Inert qualification host compiled as WindowsApplication BEFORE observation.
// Hosting the journal fixture in a runspace avoids ConsoleHost infrastructure.
public static class StopFixtureRunner {
    [STAThread]
    public static int Main(string[] arguments) {
        if (arguments.Length != 4) return 2;
        try {
            using (PowerShell shell=PowerShell.Create()) {
                shell.AddCommand(arguments[0]).AddParameter("RequestPath",arguments[1])
                    .AddParameter("CaseDirectory",arguments[2]).AddParameter("Scenario",arguments[3]);
                shell.Invoke();
                if (shell.HadErrors) {
                    foreach (var error in shell.Streams.Error) File.AppendAllText(Path.Combine(arguments[2],"host-error.txt"),error.ToString()+Environment.NewLine);
                    return 1;
                }
            }
            return 0;
        } catch (Exception error) {
            File.WriteAllText(Path.Combine(arguments[2],"host-error.txt"),error.ToString()); return 1;
        }
    }
}
