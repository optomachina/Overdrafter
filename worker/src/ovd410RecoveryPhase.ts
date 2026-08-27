import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

export const OVD410_RECOVERY_PHASE_PATH =
  "/run/ovd410-recovery-phase/last-stage";

export const OVD410_RECOVERY_PHASES = [
  "control-preverify",
  "container-start",
  "tool-start",
  "profile-ready",
  "browser-launch",
  "provider-navigation",
  "owner-wait",
  "interactive-verified",
  "cold-relaunch",
  "cold-verified",
  "identity-promoted",
  "control-postverify",
  "payload-complete",
] as const;

export type Ovd410RecoveryPhase = (typeof OVD410_RECOVERY_PHASES)[number];

export interface Ovd410RecoveryPhaseReporter {
  readonly enabled: boolean;
  write(stage: Ovd410RecoveryPhase): Promise<void>;
}

function permissionBits(mode: number) {
  return mode & 0o777;
}

function phaseIndex(value: string) {
  return OVD410_RECOVERY_PHASES.indexOf(value as Ovd410RecoveryPhase);
}

async function requireSecureDirectory(directory: string, expectedUid: number) {
  const stats = await fs.lstat(directory);
  if (
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    stats.uid !== expectedUid ||
    permissionBits(stats.mode) !== 0o700
  ) {
    throw new Error("OVD-410 recovery phase channel is invalid.");
  }
}

async function readCurrentPhase(phasePath: string, expectedUid: number) {
  let stats;
  try {
    stats = await fs.lstat(phasePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.uid !== expectedUid ||
    permissionBits(stats.mode) !== 0o600 ||
    stats.size > 64
  ) {
    throw new Error("OVD-410 recovery phase channel is invalid.");
  }
  const value = await fs.readFile(phasePath, "utf8");
  if (!value.endsWith("\n") || value.indexOf("\n") !== value.length - 1) {
    throw new Error("OVD-410 recovery phase channel is invalid.");
  }
  const stage = value.slice(0, -1);
  if (phaseIndex(stage) < 0) {
    throw new Error("OVD-410 recovery phase channel is invalid.");
  }
  return stage as Ovd410RecoveryPhase;
}

/**
 * Create the optional recovery-only finite phase reporter.
 *
 * The host control owns and mounts the root-only runtime directory. This
 * writer refuses alternate paths, insecure metadata, malformed content, and
 * out-of-order transitions before atomically replacing the 0600 marker.
 */
export async function createOvd410RecoveryPhaseReporter(options?: {
  phasePath?: string;
  expectedPath?: string;
  expectedUid?: number;
}): Promise<Ovd410RecoveryPhaseReporter> {
  const phasePath = options?.phasePath ?? process.env.OVD410_RECOVERY_PHASE_PATH;
  if (!phasePath) {
    return { enabled: false, write: async () => undefined };
  }

  const expectedPath = options?.expectedPath ?? OVD410_RECOVERY_PHASE_PATH;
  const expectedUid = options?.expectedUid ?? 0;
  if (phasePath !== expectedPath) {
    throw new Error("OVD-410 recovery phase channel is invalid.");
  }
  const directory = path.dirname(phasePath);
  await requireSecureDirectory(directory, expectedUid);

  return {
    enabled: true,
    async write(stage) {
      await requireSecureDirectory(directory, expectedUid);
      const current = await readCurrentPhase(phasePath, expectedUid);
      const currentIndex = current === null ? -1 : phaseIndex(current);
      const nextIndex = phaseIndex(stage);
      if (nextIndex !== currentIndex + 1) {
        throw new Error("OVD-410 recovery phase transition is invalid.");
      }

      const temporaryPath = path.join(
        directory,
        `.last-stage.${randomUUID()}.tmp`,
      );
      let handle: fs.FileHandle | undefined;
      try {
        handle = await fs.open(temporaryPath, "wx", 0o600);
        await handle.writeFile(`${stage}\n`, "utf8");
        await handle.sync();
        await handle.close();
        handle = undefined;
        await fs.chmod(temporaryPath, 0o600);
        await fs.rename(temporaryPath, phasePath);
      } finally {
        await handle?.close().catch(() => undefined);
        await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
      }

      const written = await readCurrentPhase(phasePath, expectedUid);
      if (written !== stage) {
        throw new Error("OVD-410 recovery phase channel is invalid.");
      }
    },
  };
}
