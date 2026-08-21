import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { VendorAutomationError } from "../types.js";

/**
 * Chrome / Chromium writes a `SingletonLock` symlink into a user-data-dir
 * whenever a session is active. Two patchright/playwright processes that try
 * to launch persistent contexts against the same dir will collide. The other
 * collision source we have to worry about is Composer (or any other agent) —
 * those run outside our codebase but use the same `SingletonLock` mechanism.
 *
 * This helper inspects the lock symlink directly. macOS / Linux Chrome encodes
 * the lock target as `<host>-<pid>`. We treat:
 *   - missing dir or missing lock → free, proceed
 *   - lock present but PID dead → stale, log + proceed (Chrome itself will
 *     overwrite stale locks)
 *   - lock present and PID alive → busy; poll until cleared or budget expires
 *   - lock present, target unparseable → assume busy and surface a clear
 *     error rather than guessing
 *
 * Native browser locks catch non-cooperating browser sessions. The lifecycle
 * wrapper below also creates a sidecar lock so cooperating worker processes
 * serialize snapshot restore, browser use, and persistence as one operation.
 */

export type AcquireProfileLockOptions = {
  /** Maximum time to wait for an existing lock to clear, in ms. Default 30 s. */
  waitMs?: number;
  /** Vendor name used to attribute the failure. Default "xometry". */
  vendor?: string;
  /** Logger for stale-lock warnings. Defaults to console.warn. */
  logWarn?: (message: string, context: Record<string, unknown>) => void;
};

type LockState =
  | { kind: "free" }
  | { kind: "stale"; target: string }
  | { kind: "busy"; pid: number; host: string | null; target: string }
  | { kind: "unparseable"; target: string };

export async function inspectProfileLock(
  userDataDir: string,
): Promise<LockState> {
  const chromiumState = await inspectNativeProfileLock(
    path.join(userDataDir, "SingletonLock"),
    /-(\d+)$/,
  );
  if (chromiumState.kind !== "free" && chromiumState.kind !== "stale")
    return chromiumState;
  const firefoxState = await inspectNativeProfileLock(
    path.join(userDataDir, "lock"),
    /[+-](\d+)$/,
  );
  return firefoxState.kind === "free" ? chromiumState : firefoxState;
}

async function inspectNativeProfileLock(
  lockPath: string,
  pidPattern: RegExp,
): Promise<LockState> {
  let target: string;
  try {
    target = await fs.readlink(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "free" };
    }
    // EACCES, EINVAL (regular file rather than symlink), etc. — surface as
    // unparseable so the caller can decide whether to throw.
    return { kind: "unparseable", target: "(unreadable)" };
  }

  // Chrome encodes `<host>-<pid>` on macOS/Linux. Windows uses a different
  // format we don't support here (the worker only runs on macOS/Linux).
  const pidMatch = pidPattern.exec(target);
  const pid = Number.parseInt(pidMatch?.[1] ?? "", 10);
  if (!Number.isFinite(pid) || pid <= 0) {
    return { kind: "unparseable", target };
  }
  const host =
    target.slice(0, pidMatch?.index ?? 0).replace(/[-+]$/, "") || null;

  if (!isProcessAlive(pid)) {
    return { kind: "stale", target };
  }
  return { kind: "busy", pid, host, target };
}

/** Serialize cooperating processes across restore, launch, close, and snapshot persistence. */
export async function withXometryProfileInterprocessLock<T>(
  userDataDir: string,
  opts: AcquireProfileLockOptions,
  operation: () => Promise<T>,
): Promise<T> {
  const lockPath = `${userDataDir}.overdrafter-profile-lock`;
  const waitMs = opts.waitMs ?? 30_000;
  const deadline = Date.now() + waitMs;
  const owner = JSON.stringify({ host: os.hostname(), pid: process.pid });
  await fs.mkdir(path.dirname(lockPath), { recursive: true });

  for (;;) {
    try {
      await fs.writeFile(lockPath, owner, { flag: "wx", mode: 0o600 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await readProfileLockOwner(lockPath);
      if (isStaleLocalOwner(existing)) {
        await fs.unlink(lockPath).catch(() => undefined);
        continue;
      }
      if (Date.now() >= deadline) {
        throw new VendorAutomationError(
          `Xometry profile lifecycle is already owned by another process at ${userDataDir}.`,
          "profile_in_use",
          { vendor: opts.vendor ?? "xometry", userDataDir, waitMs },
        );
      }
      await sleep(1_000);
    }
  }

  try {
    await acquireXometryProfileLock(userDataDir, opts);
    return await operation();
  } finally {
    await fs.unlink(lockPath).catch(() => undefined);
  }
}

type ProfileLockOwner = { host?: string; pid?: number };

async function readProfileLockOwner(
  lockPath: string,
): Promise<ProfileLockOwner | null> {
  try {
    return JSON.parse(await fs.readFile(lockPath, "utf8")) as ProfileLockOwner;
  } catch {
    // An unreadable ownership record is treated as live and fails closed on timeout.
    return null;
  }
}

function isStaleLocalOwner(owner: ProfileLockOwner | null): boolean {
  return (
    owner?.host === os.hostname() &&
    Number.isSafeInteger(owner.pid) &&
    !isProcessAlive(owner.pid as number)
  );
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ESRCH") return false;
    // EPERM means the process exists but we can't signal it (different uid) —
    // treat as alive to avoid clobbering someone else's profile session.
    if (err.code === "EPERM") return true;
    return false;
  }
}

export async function acquireXometryProfileLock(
  userDataDir: string,
  opts: AcquireProfileLockOptions = {},
): Promise<void> {
  const waitMs = opts.waitMs ?? 30_000;
  const vendor = opts.vendor ?? "xometry";
  const logWarn = opts.logWarn ?? defaultWarnLogger;
  const deadline = Date.now() + waitMs;
  const pollIntervalMs = 1_000;

  for (;;) {
    const state = await inspectProfileLock(userDataDir);
    if (state.kind === "free") return;
    if (state.kind === "stale") {
      logWarn("Stale Chrome SingletonLock detected; proceeding.", {
        vendor,
        userDataDir,
        target: state.target,
      });
      return;
    }
    if (state.kind === "unparseable") {
      throw new VendorAutomationError(
        `Could not parse the existing Chrome profile lock at ${userDataDir}. ` +
          `Close any other Chrome / Composer / Playwright session using this profile and retry.`,
        "profile_in_use",
        { vendor, userDataDir, lockTarget: state.target },
      );
    }

    // busy
    if (Date.now() >= deadline) {
      throw new VendorAutomationError(
        `Xometry persistent Chrome profile is in use by another process (pid ${state.pid}). ` +
          `Close the other Chrome / Composer / Playwright session that is holding ${userDataDir} and retry.`,
        "profile_in_use",
        {
          vendor,
          userDataDir,
          holderPid: state.pid,
          holderHost: state.host,
          lockTarget: state.target,
          waitMs,
        },
      );
    }
    await sleep(pollIntervalMs);
  }
}

function defaultWarnLogger(message: string, context: Record<string, unknown>) {
  console.warn(
    JSON.stringify({
      level: "warn",
      source: "persistentProfileLock",
      message,
      context,
    }),
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
