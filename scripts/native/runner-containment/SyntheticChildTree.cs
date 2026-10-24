using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Threading;

/// <summary>
/// Harmless closed helper for a future separately admitted Workstation qualification.
/// It performs no CAD/COM, network, service, shell, credential, or external-file action.
/// </summary>
public static class SyntheticChildTree
{
    private const int SelfDeadlineMilliseconds = 30000;

    public static int Main(string[] args)
    {
        try
        {
            if (args.Length != 2) throw new ArgumentException("Expected one mode and one attempt root.");
            string mode = args[0];
            string root = FreshAbsoluteDirectory(args[1]);
            long deadline = DeadlineAfter(SelfDeadlineMilliseconds);
            switch (mode)
            {
                case "root-exit":
                    Mark(root, "root.ready");
                    return WaitForRelease(root, deadline) ? 0 : 24;
                case "tree-exit":
                case "tree-timeout":
                    return RunTree(root, mode == "tree-exit", deadline);
                case "child-limit":
                    return RunChildLimit(root, deadline);
                case "child":
                    return RunChild(root, deadline);
                case "grandchild":
                    Mark(root, "grandchild.ready");
                    return WaitForRelease(root, deadline) ? 0 : 24;
                case "hold-a":
                case "hold-b":
                    Mark(root, mode + ".ready");
                    return WaitForRelease(root, deadline) ? 0 : 24;
                default:
                    throw new ArgumentException("Unknown helper mode.");
            }
        }
        catch (ArgumentException) { return 2; }
        catch (Exception) { return 1; }
    }

    private static int RunTree(string root, bool releasable, long deadline)
    {
        using (Process child = StartSelf("child", root))
        {
            Mark(root, "root.ready");
            if (!WaitForMarkers(root, new[] { "child.ready", "grandchild.ready" }, deadline)) return 25;
            if (releasable && !WaitForRelease(root, deadline)) return 24;
            if (!releasable) Thread.Sleep((int)RemainingMilliseconds(deadline));
            if (!child.WaitForExit((int)RemainingMilliseconds(deadline))) return 26;
            return child.ExitCode;
        }
    }

    private static int RunChild(string root, long deadline)
    {
        using (Process grandchild = StartSelf("grandchild", root))
        {
            Mark(root, "child.ready");
            if (!WaitForRelease(root, deadline)) return 24;
            if (!grandchild.WaitForExit((int)RemainingMilliseconds(deadline))) return 26;
            return grandchild.ExitCode;
        }
    }

    private static int RunChildLimit(string root, long deadline)
    {
        List<Process> children = new List<Process>();
        try
        {
            children.Add(StartSelf("hold-a", root));
            children.Add(StartSelf("hold-b", root));
            if (!WaitForMarkers(root, new[] { "hold-a.ready", "hold-b.ready" }, deadline)) return 25;
            try
            {
                using (Process unexpected = StartSelf("grandchild", root)) { }
                Mark(root, "fourth.unexpected");
                return 27;
            }
            catch (Win32Exception error)
            {
                Mark(root, "fourth.denied." + error.NativeErrorCode);
                return WaitForRelease(root, deadline) ? 0 : 24;
            }
        }
        finally
        {
            foreach (Process child in children)
            {
                try { if (!child.HasExited) child.WaitForExit((int)RemainingMilliseconds(deadline)); }
                finally { child.Dispose(); }
            }
        }
    }

    private static Process StartSelf(string mode, string root)
    {
        string executable = Process.GetCurrentProcess().MainModule.FileName;
        ProcessStartInfo start = new ProcessStartInfo(executable, Quote(mode) + " " + Quote(root));
        start.UseShellExecute = false;
        start.CreateNoWindow = true;
        start.RedirectStandardInput = false;
        start.RedirectStandardOutput = false;
        start.RedirectStandardError = false;
        Process process = Process.Start(start);
        if (process == null) throw new InvalidOperationException("Child start failed.");
        return process;
    }

    private static string FreshAbsoluteDirectory(string value)
    {
        if (String.IsNullOrWhiteSpace(value) || !Path.IsPathRooted(value)
            || value.IndexOfAny(new[] { '\0', '\r', '\n' }) >= 0)
            throw new ArgumentException("Attempt root must be absolute.");
        string root = Path.GetFullPath(value).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        if (!Directory.Exists(root) || File.Exists(Path.Combine(root, "outside.marker")))
            throw new ArgumentException("Attempt root is unavailable.");
        return root;
    }

    private static void Mark(string root, string name)
    {
        string path = Path.Combine(root, name);
        using (FileStream file = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.Read))
        using (StreamWriter writer = new StreamWriter(file)) { writer.Write("ready"); }
    }

    private static bool WaitForRelease(string root, long deadline)
    {
        return WaitForMarkers(root, new[] { "release.marker" }, deadline);
    }

    private static bool WaitForMarkers(string root, string[] names, long deadline)
    {
        do
        {
            bool complete = true;
            foreach (string name in names) complete = complete && File.Exists(Path.Combine(root, name));
            if (complete) return true;
            Thread.Sleep(20);
        } while (RemainingMilliseconds(deadline) > 0);
        return false;
    }

    private static long DeadlineAfter(int milliseconds) { return Stopwatch.GetTimestamp() + (long)(milliseconds * (double)Stopwatch.Frequency / 1000); }
    private static uint RemainingMilliseconds(long deadline)
    {
        long ticks = deadline - Stopwatch.GetTimestamp();
        return ticks <= 0 ? 0 : (uint)Math.Min(Int32.MaxValue, Math.Ceiling(ticks * 1000.0 / Stopwatch.Frequency));
    }
    private static string Quote(string value)
    {
        if (value == null || value.IndexOfAny(new[] { '\0', '\r', '\n' }) >= 0) throw new ArgumentException("Invalid argument.");
        if (value.Length > 0 && value.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) return value;
        System.Text.StringBuilder result = new System.Text.StringBuilder("\""); int slashes = 0;
        foreach (char character in value)
        {
            if (character == '\\') { slashes++; continue; }
            result.Append('\\', character == '"' ? slashes * 2 + 1 : slashes).Append(character); slashes = 0;
        }
        return result.Append('\\', slashes * 2).Append('"').ToString();
    }
}
