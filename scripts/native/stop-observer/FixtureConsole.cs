using System;
using System.Threading;
using System.IO;
using System.Diagnostics;

// Compiled by the actual observed csc.exe into a console-subsystem executable.
public static class StopFixtureConsole {
    public static int Main(string[] arguments) {
        if (arguments.Length == 2 && arguments[0] == "native") {
            var clock=Stopwatch.StartNew();
            while (!File.Exists(arguments[1]) && clock.ElapsedMilliseconds < 10000) Thread.Sleep(10);
            return File.Exists(arguments[1]) ? 0 : 5;
        }
        if (arguments.Length != 1) return 2;
        if (arguments[0] == "lifecycle") { Thread.Sleep(500); return 0; }
        if (arguments[0] == "operation") {
            string challenge=Console.ReadLine();
            if (challenge != "fixture-stdin") return 3;
            Console.Out.WriteLine("fixture-stdout"); Console.Error.WriteLine("fixture-stderr");
            Thread.Sleep(500); return 0;
        }
        return 4;
    }
}
