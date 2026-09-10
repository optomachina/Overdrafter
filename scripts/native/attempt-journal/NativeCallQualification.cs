// Included only by the explicit original-synthetic-job qualification build.
// Ordinary prepared, recovery and preview helpers do not compile these hooks.
#if OVD_QUALIFY_NATIVE_CALL
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using SolidWorks.Interop.sldworks;

partial class PreparedDimensionProbe
{
    static string QualificationBoundary, QualificationSource, QualificationNonce, QualificationDirectory;
    static bool QualificationEntered;

    static void InitializeNativeCallQualification(string settingsPath, Dictionary<string, object> settings)
    {
        QualificationBoundary = (string)settings["qualificationBoundary"];
        QualificationSource = (string)settings["qualificationSourceCommit"];
        QualificationNonce = (string)settings["qualificationNonce"];
        QualificationDirectory = Path.GetDirectoryName(Path.GetFullPath(settingsPath));
        Guid nonce;
        Need((QualificationBoundary == "open_call" || QualificationBoundary == "part_save_call" ||
            QualificationBoundary == "assembly_save_call") && Regex.IsMatch(QualificationSource, "\\A[0-9a-f]{40}\\z") &&
            Guid.TryParseExact(QualificationNonce, "D", out nonce) && nonce != Guid.Empty && nonce.ToString("D") == QualificationNonce &&
            PathEqual(Path.GetDirectoryName(Package), QualificationDirectory) &&
            Path.GetFileName(QualificationDirectory) == (string)settings["attemptId"] &&
            ExpectedDepth == .005 && TargetDepth == .008, "native_call_qualification_scope");
    }

    // Pre-notification happens inside the real synchronous COM call. It proves
    // neither that disk writes have started nor that an interrupted file is sound.
    sealed class NativeCallSubscription : IDisposable
    {
        readonly string path, eventName;
        Action detach;
        bool entered;
        internal NativeCallSubscription(string expectedPath, string name) { path = expectedPath; eventName = name; }
        internal void SetDetach(Action action) { detach = action; }
        internal int OnNotification(string fileName)
        {
            try {
                Need(PathEqual(fileName, path) && InPackage(fileName) && !entered && !QualificationEntered,
                    "native_call_callback_scope");
                entered = true; QualificationEntered = true;
                WriteNativeCallReceipt("entered", path, eventName);
                var timer = Stopwatch.StartNew();
                while (timer.ElapsedMilliseconds < 60000) Thread.Sleep(100);
                WriteNativeCallReceipt("released", path, eventName);
            } catch (Exception error) {
                // A callback failure must never escape as permission to continue.
                Report["qualificationCallbackError"] = error.Message;
            }
            return 1;
        }
        public void Dispose()
        {
            Exception detachError = null;
            try { if (detach != null) detach(); }
            catch (Exception error) { detachError = error; }
            // Even an absent callback or elapsed pause cannot become a good
            // candidate. Preserve cleanup failure without losing that refusal.
            throw new InvalidOperationException(entered ? "Qualified native call returned; interruption not established." :
                "Required native pre-notification was not observed.", detachError);
        }
    }

    static IDisposable QualifyNativeOpen(string path, string phase)
    {
        if (QualificationBoundary != "open_call" || phase != "before_part_0") return null;
        var subscription = new NativeCallSubscription(path, "FileOpenPreNotify");
        var source = (DSldWorksEvents_Event)Sw;
        DSldWorksEvents_FileOpenPreNotifyEventHandler handler = subscription.OnNotification;
        source.FileOpenPreNotify += handler;
        subscription.SetDetach(() => source.FileOpenPreNotify -= handler);
        return subscription;
    }

    static IDisposable QualifyNativeSave(IModelDoc2 model, string path, string phase)
    {
        if (QualificationBoundary == "part_save_call" && phase == "part_save") {
            var subscription = new NativeCallSubscription(path, "Part.FileSaveNotify");
            var source = (DPartDocEvents_Event)model;
            DPartDocEvents_FileSaveNotifyEventHandler handler = subscription.OnNotification;
            source.FileSaveNotify += handler;
            subscription.SetDetach(() => source.FileSaveNotify -= handler);
            return subscription;
        }
        if (QualificationBoundary == "assembly_save_call" && phase == "assembly_save") {
            var subscription = new NativeCallSubscription(path, "Assembly.FileSaveNotify");
            var source = (DAssemblyDocEvents_Event)model;
            DAssemblyDocEvents_FileSaveNotifyEventHandler handler = subscription.OnNotification;
            source.FileSaveNotify += handler;
            subscription.SetDetach(() => source.FileSaveNotify -= handler);
            return subscription;
        }
        return null;
    }

    static void WriteNativeCallReceipt(string phase, string path, string eventName)
    {
        using (var process = Process.GetCurrentProcess()) {
            var receipt = new Dictionary<string, object> {
                {"schema", "overdrafter.native-call-checkpoint.v1"}, {"phase", phase},
                {"boundary", QualificationBoundary}, {"sourceCommit", QualificationSource}, {"nonce", QualificationNonce},
                {"jobId", Report["jobId"]}, {"attemptId", Report["attemptId"]},
                {"requestSha256", Report["requestSha256"]}, {"contextSha256", Report["contextSha256"]},
                {"eventName", eventName}, {"path", path}, {"candidateRoot", Package}, {"pauseMs", 60000},
                {"helperPid", process.Id}, {"helperCreationTicks", process.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture)},
                {"sessionId", process.SessionId}, {"helperPath", process.MainModule.FileName}, {"helperSha256", Hash(process.MainModule.FileName)},
                {"nativePid", ExpectedPid}, {"nativeCreationTicks", ExpectedTicks.ToString(CultureInfo.InvariantCulture)},
                {"nativePath", NativeExe}, {"nativeSha256", NativeHash}, {"utc", DateTime.UtcNow.ToString("o")}
            };
            string temporary = Path.Combine(QualificationDirectory, "native-call-" + phase + ".pending");
            string final = Path.Combine(QualificationDirectory, "native-call-" + phase + ".json");
            byte[] bytes = new UTF8Encoding(false, true).GetBytes(Json.Serialize(receipt));
            using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None)) {
                stream.Write(bytes, 0, bytes.Length); stream.Flush(true);
            }
            File.Move(temporary, final);
        }
    }
}
#endif
