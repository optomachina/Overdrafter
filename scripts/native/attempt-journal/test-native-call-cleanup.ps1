#requires -Version 5.1
# Compile the actual subscription class with inert surrounding dependencies.
# Callback state is simulated; no COM call, native process or timed pause runs.
$ErrorActionPreference='Stop'; Set-StrictMode -Version Latest
$source=[IO.File]::ReadAllText((Join-Path $PSScriptRoot 'NativeCallQualification.cs'))
$start=$source.IndexOf('    sealed class NativeCallSubscription : IDisposable',[StringComparison]::Ordinal)
$end=$source.IndexOf('    static IDisposable QualifyNativeOpen(',[StringComparison]::Ordinal)
if ($start -lt 0 -or $end -le $start) { throw 'Actual native subscription class missing.' }
$subscription=$source.Substring($start,$end-$start)
$probe=[IO.File]::ReadAllText((Join-Path $PSScriptRoot '../prepared-dimension/PreparedDimensionProbe.cs'))
$callStart=$probe.IndexOf('    static T Call<T>(',[StringComparison]::Ordinal)
$callEnd=$probe.IndexOf('    static T Own<T>(',[StringComparison]::Ordinal)
if ($callStart -lt 0 -or $callEnd -le $callStart) { throw 'Actual native call wrapper missing.' }
$call=$probe.Substring($callStart,$callEnd-$callStart)
$prefix=@'
#define OVD_QUALIFY_NATIVE_CALL
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Reflection;
using System.Threading;
public static class NativeCallCleanupFixture
{
    static bool QualificationEntered;
    static class Json { public static string Serialize(object value) { return "{}"; } }
    static readonly Dictionary<string, object> Report = new Dictionary<string, object>();
    static void Need(bool condition, string message) { if (!condition) throw new InvalidOperationException(message); }
    static bool PathEqual(string left, string right) { return left == right; }
    static bool InPackage(string path) { return true; }
    static void WriteNativeCallReceipt(string phase, string path, string name)
    { throw new InvalidOperationException("This test must never invoke a native callback."); }
'@
$suffix=@'
    static int CheckUnwind(bool failingDetach)
    {
        Report.Clear();
        var native = new ApplicationException("Synthetic native call failure.", new Exception("Native root cause."));
        var detach = new ApplicationException("Synthetic unwind detach failure.");
        var subscription = new NativeCallSubscription("fixture", "fixture");
        subscription.SetDetach(() => { if (failingDetach) throw detach; });
        try { using (subscription) Call<int>("native_fixture", () => { throw native; }); }
        catch (InvalidOperationException error) { Report["error"] = error.Message; }
        // Rethrow adds an outer stack frame after the report is captured. Assert
        // both exception causes rather than that later, expanded stack string.
        Need(Report.ContainsKey("qualificationNativeCallError") &&
            ((string)Report["qualificationNativeCallError"]).Contains(native.GetType().FullName + ": " + native.Message) &&
            ((string)Report["qualificationNativeCallError"]).Contains(native.InnerException.GetType().FullName + ": " + native.InnerException.Message),
            "Native call and root cause must survive exception unwind in the saved report.");
        Need(Report.ContainsKey("qualificationDetachError") == failingDetach,
            "Saved report must distinguish present and absent detach failure.");
        if (failingDetach) Need((string)Report["qualificationDetachError"] == detach.ToString(),
            "Saved report must retain the full detach cause.");
        Need((string)Report["error"] == "Required native pre-notification was not observed.",
            "Saving both causes cannot turn qualification into success.");
        return failingDetach ? 4 : 3;
    }
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
        return checks + CheckUnwind(false) + CheckUnwind(true);
    }
}
'@
Add-Type -TypeDefinition ($prefix+[Environment]::NewLine+$subscription+[Environment]::NewLine+$call+[Environment]::NewLine+$suffix) -Language CSharp
$checks=[NativeCallCleanupFixture]::Run()
[pscustomobject]@{schema='overdrafter.native-call-cleanup-tests.v1';passed=$true;assertions=$checks;
    nativeActions=0;callbackState='simulated';source='actual subscription and call wrapper'} | ConvertTo-Json -Compress
