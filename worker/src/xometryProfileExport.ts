import {
  withXometryProfileInterprocessLock,
  type AcquireProfileLockOptions,
} from "./adapters/persistentProfileLock.js";
import type { WorkerConfig } from "./types.js";
import { createXometryProfileArchive } from "./xometryProfileSnapshot.js";

type LockedProfileExportInput = {
  userDataDir: string;
  browserEngine: WorkerConfig["xometryBrowserEngine"];
  outputPath: string;
};

type LockedProfileExportDependencies = {
  withProfileLock: (
    userDataDir: string,
    options: AcquireProfileLockOptions,
    operation: () => Promise<void>,
  ) => Promise<void>;
  createArchive: typeof createXometryProfileArchive;
};

const defaultDependencies: LockedProfileExportDependencies = {
  withProfileLock: withXometryProfileInterprocessLock,
  createArchive: createXometryProfileArchive,
};

/** Create a profile archive only while the closed-browser lifecycle lock is held. */
export async function createLockedXometryProfileArchive(
  input: LockedProfileExportInput,
  dependencies: LockedProfileExportDependencies = defaultDependencies,
): Promise<void> {
  await dependencies.withProfileLock(
    input.userDataDir,
    { waitMs: 0, vendor: "xometry-profile-export" },
    () => dependencies.createArchive(input),
  );
}
