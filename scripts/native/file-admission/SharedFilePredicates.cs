using System;
using System.IO;
using System.Security.Cryptography;

// Preserved experimental reader predicates, not a production admission boundary.
// See README.md for origin, platform assumptions and unsupported alias/race cases.
internal static class SharedFilePredicates
{
    internal static string Hash(string path, Action<string> contentRead = null)
    {
        if (contentRead != null)
        {
            contentRead(path);
        }

        using (var stream = new FileStream(path, FileMode.Open, FileAccess.Read,
            FileShare.ReadWrite | FileShare.Delete))
        using (var hash = SHA256.Create())
        {
            return BitConverter.ToString(hash.ComputeHash(stream))
                .Replace("-", "").ToLowerInvariant();
        }
    }

    internal static bool PathEqual(string a, string b)
    {
        return !String.IsNullOrEmpty(a) && !String.IsNullOrEmpty(b)
            && String.Equals(Path.GetFullPath(a), Path.GetFullPath(b),
                StringComparison.OrdinalIgnoreCase);
    }

    internal static bool InPackage(string path, string package)
    {
        return Path.GetFullPath(path).StartsWith(
            Path.GetFullPath(package).TrimEnd('\\') + "\\",
            StringComparison.OrdinalIgnoreCase);
    }

    internal static bool MatchesFile(string path, long expectedBytes,
        string expectedHash, Action<string> contentRead = null)
    {
        return new FileInfo(path).Length == expectedBytes
            && Hash(path, contentRead) == expectedHash;
    }
}
