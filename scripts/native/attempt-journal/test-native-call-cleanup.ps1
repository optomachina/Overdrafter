#requires -Version 5.1
# Compile the actual subscription class with inert surrounding dependencies.
# Callback state is simulated; no COM call, native process or timed pause runs.
$ErrorActionPreference='Stop'; Set-StrictMode -Version Latest
$source=[IO.File]::ReadAllText((Join-Path $PSScriptRoot 'NativeCallQualification.cs'))
$start=$source.IndexOf('    sealed class NativeCallSubscription : IDisposable',[StringComparison]::Ordinal)
$end=$source.IndexOf('    static IDisposable QualifyNativeOpen(',[StringComparison]::Ordinal)
if ($start -lt 0 -or $end -le $start) { throw 'Actual native subscription class missing.' }
$subscription=$source.Substring($start,$end-$start)
$prefix=@'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Reflection;
using System.Threading;
public static class NativeCallCleanupFixture
{
    static bool QualificationEntered;
    static readonly Dictionary<string, object> Report = new Dictionary<string, object>();
    static void Need(bool condition, string message) { if (!condition) throw new InvalidOperationException(message); }
    static bool PathEqual(string left, string right) { return left == right; }
    static bool InPackage(string path) { return true; }
    static void WriteNativeCallReceipt(string phase, string path, string name)
    { throw new InvalidOperationException("This test must never invoke a native callback."); }
'@
$suffix=@'
    public static int Run()
    {
        int checks = 0;
        foreach (bool entered in new[] { false, true }) {
            foreach (string cleanup in new[] { "absent", "success", "failure" }) {
                int calls = 0;
                var original = new ApplicationException("Synthetic event detach failure.");
                var subscription = new NativeCallSubscription("fixture", "fixture");
                typeof(NativeCallSubscription).GetField("entered", BindingFlags.Instance | BindingFlags.NonPublic)
                    .SetValue(subscription, entered);
                if (cleanup != "absent") subscription.SetDetach(() => {
                    calls++;
                    if (cleanup == "failure") throw original;
                });
                InvalidOperationException failure = null;
                try { subscription.Dispose(); }
                catch (InvalidOperationException error) { failure = error; }
                Need(failure != null && failure.Message == (entered
                    ? "Qualified native call returned; interruption not established."
                    : "Required native pre-notification was not observed."), "Qualification must always fail with its original reason.");
                checks++;
                Need(calls == (cleanup == "absent" ? 0 : 1), "Detach must run exactly once when present.");
                checks++;
                Need(Object.ReferenceEquals(failure.InnerException, cleanup == "failure" ? original : null),
                    "Detach failure evidence must be preserved as the original inner exception.");
                checks++;
            }
        }
        return checks;
    }
}
'@
Add-Type -TypeDefinition ($prefix+[Environment]::NewLine+$subscription+[Environment]::NewLine+$suffix) -Language CSharp
$checks=[NativeCallCleanupFixture]::Run()
[pscustomobject]@{schema='overdrafter.native-call-cleanup-tests.v1';passed=$true;assertions=$checks;
    nativeActions=0;callbackState='simulated';source='actual subscription class'} | ConvertTo-Json -Compress
