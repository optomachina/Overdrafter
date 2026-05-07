import fs from "node:fs/promises";
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
 * We deliberately do NOT create our own lockfile — `SingletonLock` is the
 * canonical signal that any Chrome process (ours, Composer's, anybody's)
 * will respect.
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

export async function inspectProfileLock(userDataDir: string): Promise<LockState> {
  const lockPath = path.join(userDataDir, "SingletonLock");
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
  const dashIdx = target.lastIndexOf("-");
  if (dashIdx < 0) return { kind: "unparseable", target };
  const host = target.slice(0, dashIdx) || null;
  const pidStr = target.slice(dashIdx + 1);
  const pid = Number.parseInt(pidStr, 10);
  if (!Number.isFinite(pid) || pid <= 0) {
    return { kind: "unparseable", target };
  }

  if (!isProcessAlive(pid)) {
    return { kind: "stale", target };
  }
  return { kind: "busy", pid, host, target };
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
  console.warn(JSON.stringify({ level: "warn", source: "persistentProfileLock", message, context }));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
