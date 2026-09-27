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
                // Dot-source into the runspace global scope: JournalRunner's
                // GetNewClosure callbacks must resolve its shared functions.
                shell.AddScript(". $args[0] -RequestPath $args[1] -CaseDirectory $args[2] -Scenario $args[3]",false)
                    .AddArgument(arguments[0]).AddArgument(arguments[1]).AddArgument(arguments[2]).AddArgument(arguments[3]);
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
