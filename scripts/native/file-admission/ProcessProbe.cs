using System;
using System.Diagnostics;
using System.IO;
using System.Threading;

/// <summary>
/// Synthetic process-control fixture only. It performs no CAD/COM calls and
/// does not establish native recovery, process-tree containment or isolation.
/// </summary>
public static class ProcessProbe
{
    private static string LocalAbsolutePath(string value)
    {
        if (String.IsNullOrWhiteSpace(value) || value.Length < 3
            || !Char.IsLetter(value[0]) || value[1] != ':'
            || (value[2] != '\\' && value[2] != '/')
            || value.IndexOf(':', 2) >= 0 || value.IndexOfAny(new[] { '\r', '\n' }) >= 0)
        {
            throw new ArgumentException("Control paths must be absolute local file paths.");
        }
        return Path.GetFullPath(value);
    }

    private static int Control(string readyArgument, string releaseArgument)
    {
        string ready = LocalAbsolutePath(readyArgument);
        string release = LocalAbsolutePath(releaseArgument);
        string parent = Path.GetDirectoryName(ready);
        if (!Directory.Exists(parent)
            || !String.Equals(parent, Path.GetDirectoryName(release), StringComparison.OrdinalIgnoreCase)
            || String.Equals(ready, release, StringComparison.OrdinalIgnoreCase)
            || Directory.Exists(ready) || Directory.Exists(release) || File.Exists(release))
        {
            throw new ArgumentException("Control markers require distinct fresh files in the same existing fixture directory.");
        }
        using (var file = new FileStream(ready, FileMode.CreateNew, FileAccess.Write, FileShare.Read))
        using (var writer = new StreamWriter(file))
        {
            writer.Write("ready");
        }
        var timer = Stopwatch.StartNew();
        while (timer.ElapsedMilliseconds < 30000)
        {
            if (File.Exists(release)) return 0;
            Thread.Sleep(20);
        }
        Console.Error.WriteLine("control-deadline");
        return 24;
    }

    /// <summary>Runs one exactly selected inert mode; all errors return nonzero.</summary>
    public static int Main(string[] args)
    {
        try
        {
            if (args.Length == 0) throw new ArgumentException("A probe mode is required.");
            if (args[0] == "control")
            {
                if (args.Length != 3) throw new ArgumentException("Control requires ready and release paths.");
                return Control(args[1], args[2]);
            }
            if (args.Length != 1) throw new ArgumentException("This probe mode accepts no additional arguments.");
            switch (args[0])
            {
                case "quick":
                    Console.Write("quick-out");
                    Console.Error.Write("quick-err");
                    return 0;
                case "flood":
                    Console.WriteLine("OUT:" + new string('O', 131072) + ":END");
                    Console.Error.WriteLine("ERR:" + new string('E', 131072) + ":END");
                    return 0;
                case "exit23":
                    Console.WriteLine("exit23-out");
                    Console.Error.WriteLine("exit23-err");
                    return 23;
                case "sleep":
                    Console.WriteLine("sleep-ready");
                    Console.Out.Flush();
                    Thread.Sleep(30000);
                    return 0;
                default:
                    throw new ArgumentException("Unknown probe mode.");
            }
        }
        catch (ArgumentException error)
        {
            Console.Error.WriteLine("invalid-input: " + error.Message);
            return 2;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("probe-error: " + error.GetType().Name + ": " + error.Message);
            return 1;
        }
    }
}
