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

describe("hosted probe drift fingerprint line", () => {
  it.each([
    ["authenticated_dashboard_not_confirmed", false],
    ["authenticated_dashboard", true],
  ])("writes the fingerprint to stderr only for %s and keeps the stdout evidence line", async (reason, authenticated) => {
    vi.resetModules();
    const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "probe-drift-"));
    const fingerprintLine = { schema: "fixture-page-fingerprint.v1", provider: "xometry" };
    const bounded = {
      authenticated, reason, url: "https://www.xometry.com/quoting/home/", blockedNonReadMethods: [],
      dashboardUploadButtonVisible: false, fileSelectionPerformed: false, userInputInteractionPerformed: false,
    };
    vi.doMock("../xometryProfileSnapshot.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../xometryProfileSnapshot.js")>()),
      restoreXometryProfileSnapshot: async () => ({
        xometryBrowserEngine: "playwright", xometryUserDataDir: userDataDir,
        xometryProfileSnapshotGeneration: "41", xometryProfileLockWaitMs: 0,
        playwrightHeadless: true, playwrightDisableSandbox: false,
        playwrightDisableDevShmUsage: false, xometryBrowserChannel: null, browserTimeoutMs: 1_000,
      }),
      withXometryProfileSnapshotLock: (operation: () => Promise<unknown>) => operation(),
    }));
    vi.doMock("../xometryAuthProbe.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../xometryAuthProbe.js")>()),
      withClosingXometryAuthProbeContext: (_context: unknown, operation: () => Promise<unknown>) => operation(),
      runBoundedXometryAuthProbe: async (_context: unknown, options: { onDashboardNotConfirmed?: (value: unknown) => void }) => {
        if (!authenticated) options.onDashboardNotConfirmed?.(fingerprintLine);
        return bounded;
      },
    }));
    mocks.lock.mockImplementation(() => undefined);
    mocks.launch.mockResolvedValueOnce({ setDefaultTimeout: vi.fn(), setDefaultNavigationTimeout: vi.fn() });
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const logs = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const exitCode = process.exitCode;
    try {
      await import("./probeXometryProfileAuth.js");
      expect(process.exitCode).toBe(authenticated ? exitCode : 1);
    } finally {
      process.exitCode = exitCode;
      vi.doUnmock("../xometryProfileSnapshot.js");
      vi.doUnmock("../xometryAuthProbe.js");
      await fs.rm(userDataDir, { recursive: true, force: true });
    }
    expect(logs).toHaveBeenCalledOnce();
    expect(JSON.parse(logs.mock.calls[0][0])).toMatchObject({ ...bounded, snapshotGeneration: "41", domCaptured: false });
    if (authenticated) {
      expect(errors).not.toHaveBeenCalled();
      return;
    }
    expect(errors).toHaveBeenCalledOnce();
    expect(JSON.parse(errors.mock.calls[0][0])).toEqual({
      fixtureHealFingerprint: "fixture-page-fingerprint.v1",
      vocabularyDigest: expect.stringMatching(/^[0-9a-f]{16}$/),
      trigger: "authenticated_dashboard_not_confirmed",
      fingerprint: fingerprintLine,
    });
    expect(errors.mock.invocationCallOrder[0]).toBeLessThan(logs.mock.invocationCallOrder[0]);
  });
});

describe("hosted probe navigation failure output", () => {
  it("reports the navigation sub-stage and cause without browser diagnostics", async () => {
    vi.resetModules();
    const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "probe-navigation-"));
    vi.doMock("../xometryProfileSnapshot.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../xometryProfileSnapshot.js")>()),
      restoreXometryProfileSnapshot: async () => ({
        xometryBrowserEngine: "playwright", xometryUserDataDir: userDataDir,
        xometryProfileSnapshotGeneration: "41", xometryProfileLockWaitMs: 0,
        playwrightHeadless: true, playwrightDisableSandbox: false,
        playwrightDisableDevShmUsage: false, xometryBrowserChannel: null, browserTimeoutMs: 1_000,
      }),
      withXometryProfileSnapshotLock: (operation: () => Promise<unknown>) => operation(),
    }));
    vi.doMock("../xometryAuthProbe.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../xometryAuthProbe.js")>()),
      withClosingXometryAuthProbeContext: (_context: unknown, operation: () => Promise<unknown>) => operation(),
      runBoundedXometryAuthProbe: async () => {
        throw new Error("Xometry authentication probe navigation or inspection failed. subStage=goto cause=net_error.");
      },
    }));
    mocks.lock.mockImplementation(() => undefined);
    mocks.launch.mockResolvedValueOnce({ setDefaultTimeout: vi.fn(), setDefaultNavigationTimeout: vi.fn() });
    const output = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("test exit"); });
    try {
      await expect(import("./probeXometryProfileAuth.js")).rejects.toThrow("test exit");
    } finally {
      vi.doUnmock("../xometryProfileSnapshot.js");
      vi.doUnmock("../xometryAuthProbe.js");
      await fs.rm(userDataDir, { recursive: true, force: true });
    }
    expect(process.exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(output).toHaveBeenCalledOnce();
    expect(JSON.parse(output.mock.calls[0][0])).toEqual({
      authenticated: false, reason: "probe_failed", failureStage: "navigation_or_inspection",
      navigationOrInspection: { subStage: "goto", cause: "net_error" }, fileSelectionPerformed: false,
      userInputInteractionPerformed: false, snapshotPersisted: false,
    });
  });
});
