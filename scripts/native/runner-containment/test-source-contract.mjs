import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

const root = dirname(fileURLToPath(import.meta.url));
const read = (name) => readFile(join(root, name), "utf8");
describe("Windows Job Object source contract", () => {
  it("creates the fixed helper suspended and assigned before resume", async () => {
    const source = await read("WindowsJobObjectRunner.cs");
    assert.ok(source.includes("PROC_THREAD_ATTRIBUTE_JOB_LIST"));
    assert.ok(source.includes("CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT"));
    assert.ok(source.indexOf("UpdateProcThreadAttribute(attributeList") < source.indexOf("CreateProcessW(executable"));
    assert.ok(source.indexOf("CreateProcessW(executable") < source.indexOf("ResumeThread(process.hThread)"));
    assert.ok(source.indexOf('journal.Append("assignment_verified"') < source.indexOf("ResumeThread(process.hThread)"));
    assert.ok(source.includes("IsProcessInJob(process.hProcess, job"));
  });
  it("exposes only closed synthetic scenarios and holds exact executable bytes", async () => {
    const source = await read("WindowsJobObjectRunner.cs");
    for (const field of ["ExecutablePath", "ExecutableSha256", "WorkingDirectory", "Arguments", "TimeoutMilliseconds"])
      assert.doesNotMatch(source, new RegExp(`public string(?:\\[\\])? ${field}|public int ${field}`));
    for (const scenario of ["root-exit", "tree-exit", "tree-timeout", "child-limit"]) assert.ok(source.includes(`"${scenario}"`));
    assert.ok(source.includes('Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "SyntheticChildTree.exe")'));
    assert.ok(source.includes("request = ValidateRequest(request)"));
    assert.ok(source.includes("RunnerRequest detached = new RunnerRequest"));
    assert.ok(source.includes("FileAccess.Read, FileShare.Read"));
    assert.ok(source.indexOf("using (FileStream executableHandle") < source.indexOf("CreateProcessW(executable"));
    assert.ok(source.includes('Regex.IsMatch(value, "^[A-Za-z]:[\\\\\\\\/]"'));
    assert.ok(source.includes("DriveType != DriveType.Fixed"));
    assert.ok(source.includes("FileAttributes.ReparsePoint"));
    assert.ok(source.includes("environmentBlock = FixedEnvironment()"));
    assert.ok(source.includes('"SystemRoot=" + windows + "\\0WINDIR=" + windows + "\\0"'));
  });
  it("retains exclusive journal ownership and rejects snapshot replacement races", async () => {
    const source = await read("WindowsJobObjectRunner.cs");
    assert.ok(source.includes('"owner.lock"), FileMode.CreateNew'));
    assert.ok(source.includes("FileShare.None"));
    assert.ok(source.includes("HashFile(Path) != expectedSnapshotHash"));
    assert.ok(source.includes("File.Replace(temporary, Path, null)"));
    assert.ok(source.includes("owner.Dispose()"));
  });
  it("uses one cleanup deadline and initialized attribute-list disposal", async () => {
    const source = await read("WindowsJobObjectRunner.cs");
    assert.ok(source.includes("ref long deadline"));
    assert.ok(source.includes("RemainingMilliseconds(deadline)"));
    assert.doesNotMatch(source, /EmergencyCleanup[\s\S]*WaitForSingleObject\(process, 5000\)/);
    assert.ok(source.includes("bool created = false, empty = false, attributeInitialized = false"));
    assert.ok(source.includes("if (attributeInitialized) DeleteProcThreadAttributeList(attributeList)"));
  });
  it("classifies preflight failures without returning raw exceptions", async () => {
    const source = await read("WindowsJobObjectRunner.cs");
    assert.ok(source.indexOf("try { return RunAdmitted(request); }") < source.indexOf("private RunnerResult RunAdmitted"));
    assert.ok(source.includes('FailureCode = "journal_persistence_failed"'));
    assert.ok(source.includes('FailureCode = "process_uncertain"'));
    assert.doesNotMatch(source, /FailureCode\s*=\s*error\.ToString|FailureCode\s*=\s*error\.StackTrace/);
  });

  it("uses an unnamed non-inherited kill-on-close job without breakaway", async () => {
    const source = await read("WindowsJobObjectRunner.cs");
    assert.ok(source.includes("CreateJobObjectW(IntPtr.Zero, null)"));
    assert.ok(source.includes("JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_ACTIVE_PROCESS"));
    assert.ok(source.includes("IntPtr.Zero, IntPtr.Zero, false, flags"));
    assert.doesNotMatch(source, /BREAKAWAY_OK|SILENT_BREAKAWAY|CREATE_BREAKAWAY_FROM_JOB/);
    assert.ok(source.includes("assigned == listed"));
  });

  it("shares the journal golden digest and canonical field order", async () => {
    const source = await read("WindowsJobObjectRunner.cs");
    assert.ok(source.includes('JournalGoldenDigest = "e33f359896c8e8cf963c7afda0c4aeff7c374ffe4f5575b064ce255f4443cb03"'));
    assert.ok(source.includes("HashText(JournalGoldenBody) == JournalGoldenDigest"));
    const fields = ["attemptId", "bootId", "event", "evidence", "fence", "jobDigest", "observedUtc",
      "priorDigest", "runtimeDigest", "schema", "sequence", "workerId"];
    for (let index = 1; index < fields.length; index++)
      assert.ok(source.indexOf(`\\\"${fields[index - 1]}\\\"`) < source.indexOf(`\\\"${fields[index]}\\\"`));
  });

  it("keeps the helper deadline-bounded and requires a real Win32 denial", async () => {
    const source = await read("SyntheticChildTree.cs");
    assert.ok(source.includes("long deadline = DeadlineAfter(SelfDeadlineMilliseconds)"));
    assert.ok(source.includes("catch (Win32Exception error)"));
    assert.ok(source.includes('"fourth.denied." + error.NativeErrorCode'));
    assert.doesNotMatch(source, /catch\s*\{\s*Mark\(root, "fourth\.denied/);
    assert.doesNotMatch(source, /SolidWorks|Marshal\.GetActiveObject|WMI|Win32_Process|HttpClient|Socket|WebClient/);
  });

  it("keeps Workstation execution unconditionally disabled", async () => {
    const source = await read("qualify-windows-job-object.ps1");
    const stop = source.indexOf("throw 'not_admitted: Windows Job Object qualification requires a later exact admission.'");
    assert.ok(stop > 0);
    for (const effect of ["New-Item", "Add-Type", "Start-Process", "WindowsJobObjectRunner"])
      assert.equal(source.indexOf(effect), -1);
  });
});
