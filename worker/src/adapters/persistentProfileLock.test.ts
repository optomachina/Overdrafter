// @vitest-environment node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireXometryProfileLock,
  inspectProfileLock,
  withXometryProfileInterprocessLock,
  XOMETRY_PROFILE_LOCK_SIDECAR_SUFFIX,
} from "./persistentProfileLock";
import { VendorAutomationError } from "../types";

const tempDirs: string[] = [];

async function makeProfileDir(): Promise<string> {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "overdrafter-profile-lock-"),
  );
  tempDirs.push(dir);
  return dir;
}

async function writeLockSymlink(
  profileDir: string,
  target: string,
): Promise<void> {
  await fs.symlink(target, path.join(profileDir, "SingletonLock"));
}

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("persistentProfileLock", () => {
  it("returns free when no SingletonLock exists", async () => {
    const dir = await makeProfileDir();
    const state = await inspectProfileLock(dir);
    expect(state).toEqual({ kind: "free" });
  });

  it("classifies a stale lock (PID dead) as stale", async () => {
    const dir = await makeProfileDir();
    // PID_MAX on Linux is 4194304 by default. macOS goes higher in practice
    // (up to 99999 by default on Darwin), but neither system reuses very-large
    // synthetic PIDs. We pick a host segment + a PID that no real process owns.
    await writeLockSymlink(dir, "ghost-host-2147483646");
    const state = await inspectProfileLock(dir);
    expect(state.kind).toBe("stale");
  });

  it("classifies a live lock as busy with the holder PID", async () => {
    const dir = await makeProfileDir();
    await writeLockSymlink(dir, `localhost-${process.pid}`);
    const state = await inspectProfileLock(dir);
    expect(state.kind).toBe("busy");
    if (state.kind === "busy") {
      expect(state.pid).toBe(process.pid);
      expect(state.host).toBe("localhost");
    }
  });

  it("recognizes Firefox's native profile lock", async () => {
    const dir = await makeProfileDir();
    await fs.symlink(`${os.hostname()}+${process.pid}`, path.join(dir, "lock"));
    const state = await inspectProfileLock(dir);
    expect(state).toMatchObject({ kind: "busy", pid: process.pid });
  });

  it("classifies a malformed lock target as unparseable", async () => {
    const dir = await makeProfileDir();
    await writeLockSymlink(dir, "no-pid-segment");
    const state = await inspectProfileLock(dir);
    expect(state.kind).toBe("unparseable");
  });

  it("acquireXometryProfileLock resolves immediately when the dir is free", async () => {
    const dir = await makeProfileDir();
    await expect(
      acquireXometryProfileLock(dir, { waitMs: 100 }),
    ).resolves.toBeUndefined();
  });

  it("acquireXometryProfileLock proceeds past a stale lock with a warning", async () => {
    const dir = await makeProfileDir();
    await writeLockSymlink(dir, "ghost-2147483646");
    const warnings: Array<{
      message: string;
      context: Record<string, unknown>;
    }> = [];
    await acquireXometryProfileLock(dir, {
      waitMs: 100,
      logWarn: (message, context) => warnings.push({ message, context }),
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toMatch(/stale/i);
    expect(warnings[0].context.userDataDir).toBe(dir);
  });

  it("acquireXometryProfileLock throws profile_in_use when held by a live process", async () => {
    const dir = await makeProfileDir();
    await writeLockSymlink(dir, `localhost-${process.pid}`);
    await expect(
      acquireXometryProfileLock(dir, { waitMs: 200 }),
    ).rejects.toMatchObject({
      name: "VendorAutomationError",
      code: "profile_in_use",
      payload: {
        vendor: "xometry",
        userDataDir: dir,
        holderPid: process.pid,
      },
    });
  });

  it("acquireXometryProfileLock throws profile_in_use on unparseable lock targets", async () => {
    const dir = await makeProfileDir();
    await writeLockSymlink(dir, "garbage");
    await expect(
      acquireXometryProfileLock(dir, { waitMs: 50 }),
    ).rejects.toMatchObject({
      name: "VendorAutomationError",
      code: "profile_in_use",
    });
  });

  it("VendorAutomationError surface includes profile_in_use code", () => {
    const err = new VendorAutomationError("test", "profile_in_use", {
      holderPid: 42,
    });
    expect(err.code).toBe("profile_in_use");
    expect(err.payload.holderPid).toBe(42);
  });

  it("holds and releases the sidecar lock across the complete lifecycle", async () => {
    const dir = await makeProfileDir();
    const sidecar = `${dir}${XOMETRY_PROFILE_LOCK_SIDECAR_SUFFIX}`;

    await expect(
      withXometryProfileInterprocessLock(dir, { waitMs: 100 }, async () => {
        await expect(fs.stat(sidecar)).resolves.toMatchObject({
          mode: expect.any(Number),
        });
        throw new Error("operation failed");
      }),
    ).rejects.toThrow("operation failed");
    await expect(fs.stat(sidecar)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("creates the sidecar parent before a fresh snapshot restore", async () => {
    const root = await makeProfileDir();
    const profileDir = path.join(root, "fresh", "profile");
    await expect(
      withXometryProfileInterprocessLock(
        profileDir,
        { waitMs: 100 },
        async () => "owned",
      ),
    ).resolves.toBe("owned");
    await expect(fs.stat(path.dirname(profileDir))).resolves.toMatchObject({
      mode: expect.any(Number),
    });
  });

  it("fails closed without reclaiming a stale sidecar", async () => {
    const dir = await makeProfileDir();
    const sidecar = `${dir}${XOMETRY_PROFILE_LOCK_SIDECAR_SUFFIX}`;
    await fs.mkdir(sidecar, { mode: 0o700 });
    await fs.writeFile(
      path.join(sidecar, "owner-stale.json"),
      JSON.stringify({ host: os.hostname(), pid: 999_999_999 }),
    );

    await expect(
      withXometryProfileInterprocessLock(
        dir,
        { waitMs: 0 },
        async () => "must-not-run",
      ),
    ).rejects.toMatchObject({ code: "profile_in_use" });
    await expect(fs.stat(sidecar)).resolves.toMatchObject({
      mode: expect.any(Number),
    });
  });

  it("allows only one concurrent lifecycle owner to enter", async () => {
    const dir = await makeProfileDir();
    let releaseOwner = () => undefined;
    let releaseFirstEntered = () => undefined;
    const ownerEntered = new Promise<void>((resolve) => {
      releaseOwner = resolve;
    });
    const firstEntered = new Promise<void>((resolve) => {
      releaseFirstEntered = resolve;
    });
    let entered = 0;
    const first = withXometryProfileInterprocessLock(
      dir,
      { waitMs: 100 },
      async () => {
        entered += 1;
        releaseFirstEntered();
        await ownerEntered;
      },
    );
    await firstEntered;

    await expect(
      withXometryProfileInterprocessLock(dir, { waitMs: 0 }, async () => {
        entered += 1;
      }),
    ).rejects.toMatchObject({ code: "profile_in_use" });
    expect(entered).toBe(1);
    releaseOwner();
    await first;
  });
});
