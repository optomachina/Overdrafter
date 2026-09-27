using System;
using System.Threading;

// No window, console, child processes, files, network, COM or CAD calls.
public static class StopFixtureSleep {
    public static int Main(string[] arguments) {
        int milliseconds;
        if (arguments.Length != 1 || !int.TryParse(arguments[0],out milliseconds) || milliseconds < 0 || milliseconds > 5000) return 2;
        Thread.Sleep(milliseconds); return 0;
    }
}
