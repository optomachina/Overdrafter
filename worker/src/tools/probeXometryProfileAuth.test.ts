// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ launch: vi.fn(), lock: vi.fn() }));
vi.mock("dotenv/config", () => ({}));
vi.mock("playwright", () => ({ chromium: { launchPersistentContext: mocks.launch } }));
vi.mock("../camoufoxPersistentContext.js", () => ({ launchPersistentCamoufox: mocks.launch }));
vi.mock("../config.js", () => ({ loadConfig: () => ({
  xometryBrowserEngine: "camoufox", xometryProfileSnapshotBucket: "synthetic",
  xometryProfileSnapshotObject: "synthetic", xometryUserDataDir: "/tmp/not-written",
  xometryProfileSnapshotMaxBytes: 1024, xometryProfileLockWaitMs: 0,
}) }));
vi.mock("../adapters/persistentProfileLock.js", () => ({
  acquireXometryProfileLock: vi.fn(),
  withXometryProfileInterprocessLock: async (_path: string, _options: unknown, operation: () => Promise<unknown>) => {
    mocks.lock();
    return operation();
  },
}));

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("hosted probe restore failure output", () => {
  it.each([
    ["credential", "credential_unavailable"],
    ["metadata", "snapshot_read_failed"],
    ["download", "snapshot_read_failed"],
    ["profile_lock", "filesystem_eacces"],
  ])("reports bounded %s evidence and exits before browser launch", async (phase, reason) => {
    vi.resetModules();
    mocks.lock.mockImplementation(() => {
      if (phase === "profile_lock") throw Object.assign(new Error("private path"), { code: "EACCES" });
    });
    const request = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("metadata.google.internal")) {
        if (phase === "credential") return new Response("private token body", { status: 403 });
        return new Response(JSON.stringify({ access_token: "synthetic-token" }));
      }
      if (url.includes("alt=media") || phase === "metadata") {
        return new Response("private storage body", { status: 403 });
      }
      return new Response(JSON.stringify({ generation: "41", size: "20" }));
    });
    vi.stubGlobal("fetch", request);
    const output = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const success = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("test exit"); });
    await expect(import("./probeXometryProfileAuth.js")).rejects.toThrow("test exit");
    expect(process.exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(output).toHaveBeenCalledTimes(1);
    expect(JSON.parse(output.mock.calls[0][0])).toEqual({
      authenticated: false, reason: "probe_failed", failureStage: "snapshot_restore",
      snapshotRestore: { phase, reason }, fileSelectionPerformed: false,
      userInputInteractionPerformed: false, snapshotPersisted: false,
    });
    expect(output.mock.calls[0][0]).not.toMatch(/private|synthetic/);
    expect(success).not.toHaveBeenCalled();
    expect(mocks.launch).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes({ credential: 1, metadata: 2, download: 4, profile_lock: 0 }[phase]!);
  });
});

describe("hosted probe Chromium launch", () => {
  it.each([
    [false, [], true],
    [true, ["--no-sandbox", "--disable-setuid-sandbox"], false],
  ])("passes the sandbox decision explicitly when PLAYWRIGHT_DISABLE_SANDBOX=%s", async (disableSandbox, args, chromiumSandbox) => {
    vi.resetModules();
    const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "probe-launch-"));
    vi.doMock("../xometryProfileSnapshot.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../xometryProfileSnapshot.js")>()),
      restoreXometryProfileSnapshot: async () => ({
        xometryBrowserEngine: "playwright", xometryUserDataDir: userDataDir,
        xometryProfileSnapshotGeneration: "41", xometryProfileLockWaitMs: 0,
        playwrightHeadless: true, playwrightDisableSandbox: disableSandbox,
        playwrightDisableDevShmUsage: false, xometryBrowserChannel: null, browserTimeoutMs: 1_000,
      }),
      withXometryProfileSnapshotLock: (operation: () => Promise<unknown>) => operation(),
    }));
    mocks.lock.mockImplementation(() => undefined);
    mocks.launch.mockRejectedValueOnce(new Error("synthetic launch stop"));
    const output = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("test exit"); });
    try {
      await expect(import("./probeXometryProfileAuth.js")).rejects.toThrow("test exit");
    } finally {
      vi.doUnmock("../xometryProfileSnapshot.js");
      await fs.rm(userDataDir, { recursive: true, force: true });
    }
    expect(mocks.launch).toHaveBeenCalledOnce();
    const [launchedDir, options] = mocks.launch.mock.calls[0];
    expect(launchedDir).toBe(userDataDir);
    expect(options).toMatchObject({ chromiumSandbox, args });
    expect(JSON.parse(output.mock.calls[0][0])).toMatchObject({ failureStage: "browser_launch" });
  });
});
