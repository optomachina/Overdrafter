using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;

// Internal synthetic evidence tooling. This is not a production admission API.
internal static class FileAdmissionCases
{
    private sealed class CaseResult
    {
        public string name;
        public string observed;
        public string reason;
        public bool expectedPassed;
        public int admissionContentReads;
        public int setupHashReads;
        public int nativeCalls = 0;
        public string error;
    }

    private sealed class Control
    {
        public string path;
        public string hash;
        public long length;
        public int setupHashReads;
    }

    private static void CreateNew(string path, byte[] bytes)
    {
        using (var file = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None))
        {
            file.Write(bytes, 0, bytes.Length);
            file.Flush();
        }
    }

    private static string ContentHash(byte[] bytes)
    {
        using (var sha = SHA256.Create())
        {
            return BitConverter.ToString(sha.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant();
        }
    }

    private static Control CreateControl(string path, byte[] bytes, string expectedHash)
    {
        CreateNew(path, bytes);
        var control = new Control { path = path, hash = expectedHash, length = bytes.Length };
        string actualHash = SharedFilePredicates.Hash(path, delegate(string ignored) { control.setupHashReads++; });
        if (!String.Equals(actualHash, expectedHash, StringComparison.Ordinal)
            || !File.ReadAllBytes(path).SequenceEqual(bytes))
        {
            throw new InvalidOperationException("Synthetic setup hash or byte readback mismatch.");
        }
        return control;
    }

    private static CaseResult Evaluate(string name, string root, string actualPath,
        string expectedPath, long length, string hash, string expectedReason, int setupHashReads)
    {
        var result = new CaseResult { name = name, setupHashReads = setupHashReads };
        try
        {
            // The order is intentional: out-of-package files must not reach content reads.
            if (!SharedFilePredicates.InPackage(actualPath, root))
            {
                result.reason = "outside_allowed_root";
            }
            else if (!SharedFilePredicates.PathEqual(actualPath, expectedPath))
            {
                result.reason = "unexpected_file_path";
            }
            else if (!File.Exists(actualPath))
            {
                result.reason = "missing_required_file";
            }
            else if (!SharedFilePredicates.MatchesFile(actualPath, length, hash,
                delegate(string ignored) { result.admissionContentReads++; }))
            {
                result.reason = "digest_mismatch";
            }
            result.observed = result.reason == null ? "eligible" : "rejected";
            bool expectsNoReads = expectedReason == "outside_allowed_root"
                || expectedReason == "missing_required_file";
            bool readsExpected = expectsNoReads ? result.admissionContentReads == 0
                : result.admissionContentReads > 0;
            result.expectedPassed = String.Equals(result.reason, expectedReason, StringComparison.Ordinal)
                && readsExpected;
        }
        catch (Exception error)
        {
            result.observed = "rejected";
            result.reason = "evaluation_error";
            result.error = error.GetType().FullName + ": " + error.Message;
            result.expectedPassed = false;
        }
        return result;
    }

    private static int Main(string[] args)
    {
        var cases = new List<CaseResult>();
        var serializer = new JavaScriptSerializer();
        bool sourceOriginalHashesUnchanged = false;
        try
        {
            if (args.Length != 1 || !Path.IsPathRooted(args[0]))
                throw new ArgumentException("Exactly one existing absolute empty fixture-root argument is required.");
            string root = Path.GetFullPath(args[0]);
            if (!String.Equals(Path.GetPathRoot(args[0]), Path.GetPathRoot(root), StringComparison.OrdinalIgnoreCase)
                || !Directory.Exists(root) || Directory.EnumerateFileSystemEntries(root).Any())
                throw new ArgumentException("The fixture root must be an existing absolute empty directory.");

            string package = Path.Combine(root, "package");
            string outside = Path.Combine(root, "outside");
            string sibling = Path.Combine(root, "package-sibling");
            Directory.CreateDirectory(package);
            Directory.CreateDirectory(outside);
            Directory.CreateDirectory(sibling);
            byte[] original = Encoding.UTF8.GetBytes("OverDrafter synthetic file admission fixture v1\n");
            string hash = ContentHash(original);
            var controls = new List<Control>();
            Control source = CreateControl(Path.Combine(root, "original.bin"), original, hash);
            controls.Add(source);
            Control positive = CreateControl(Path.Combine(package, "positive.bin"), original, hash);
            controls.Add(positive);
            Control outsideControl = CreateControl(Path.Combine(outside, "candidate.bin"), original, hash);
            controls.Add(outsideControl);
            Control siblingControl = CreateControl(Path.Combine(sibling, "candidate.bin"), original, hash);
            controls.Add(siblingControl);
            string missing = Path.Combine(package, "missing.bin");
            string changed = Path.Combine(package, "changed.bin");
            Control changedSetup = CreateControl(changed, original, hash);
            using (var file = new FileStream(changed, FileMode.Open, FileAccess.Write, FileShare.None))
            {
                file.Position = 0;
                file.WriteByte((byte)(original[0] ^ 1));
                file.Flush();
            }
            byte[] changedBytes = File.ReadAllBytes(changed);
            bool sameSizeSingleByteMutation = changedBytes.Length == original.Length
                && changedBytes.Zip(original, (a, b) => a != b).Count(different => different) == 1;
            if (!sameSizeSingleByteMutation)
                throw new InvalidOperationException("The private changed-byte fixture is not a same-size one-byte mutation.");

            cases.Add(Evaluate("positive_control", package, positive.path, positive.path,
                original.Length, hash, null, positive.setupHashReads));
            cases.Add(Evaluate("missing_part", package, missing, missing,
                original.Length, hash, "missing_required_file", 0));
            cases.Add(Evaluate("changed_bytes", package, changed, changed,
                original.Length, hash, "digest_mismatch", changedSetup.setupHashReads));
            cases.Add(Evaluate("outside_root", package, outsideControl.path, Path.Combine(package, "outside.bin"),
                original.Length, hash, "outside_allowed_root", outsideControl.setupHashReads));
            cases.Add(Evaluate("prefix_sibling", package, siblingControl.path, Path.Combine(package, "sibling.bin"),
                original.Length, hash, "outside_allowed_root", siblingControl.setupHashReads));
            bool naiveSiblingPrefix = siblingControl.path.StartsWith(package, StringComparison.OrdinalIgnoreCase);
            cases[4].expectedPassed = cases[4].expectedPassed && naiveSiblingPrefix;

            int integrityHashReads = 0;
            bool allControlsUnchanged = true;
            foreach (Control control in controls)
            {
                bool unchanged = SharedFilePredicates.MatchesFile(control.path, control.length, control.hash,
                    delegate(string ignored) { integrityHashReads++; });
                allControlsUnchanged = allControlsUnchanged && unchanged;
            }
            sourceOriginalHashesUnchanged = allControlsUnchanged;
            bool passed = cases.Count == 5 && cases.All(item => item.expectedPassed)
                && sourceOriginalHashesUnchanged && sameSizeSingleByteMutation;
            Console.WriteLine(serializer.Serialize(new
            {
                outcome = passed ? "passed" : "failed",
                fileOnly = true,
                nativeCalls = 0,
                sourceOriginalHashesUnchanged = sourceOriginalHashesUnchanged,
                cases = cases,
                sourceSetupHashReads = source.setupHashReads,
                integrityHashReads = integrityHashReads,
                initialSetupByteReadbacks = controls.Count + 1,
                sameSizeSingleByteMutation = sameSizeSingleByteMutation,
                naiveSiblingPrefix = naiveSiblingPrefix,
                limits = "Synthetic lexical file predicates only; reparse points, races, native integration and isolation remain unproven."
            }));
            return passed ? 0 : 1;
        }
        catch (Exception error)
        {
            Console.WriteLine(serializer.Serialize(new
            {
                outcome = "failed",
                fileOnly = true,
                nativeCalls = 0,
                sourceOriginalHashesUnchanged = sourceOriginalHashesUnchanged,
                cases = cases,
                error = error.GetType().FullName + ": " + error.Message
            }));
            return 1;
        }
    }
}
