import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

type StorageStateSource = {
  storageState(): Promise<unknown>;
};

/**
 * Writes a browser storage state (session cookies and local storage) readable
 * only by the owner. Playwright's storageState({ path }) uses the process umask,
 * and writeFile's mode only applies when a file is created, so the state is
 * written to a fresh 0600 file beside the target and renamed over it. An
 * existing target's looser permissions are therefore never inherited.
 */
export async function writePrivateStorageState(
  context: StorageStateSource,
  outputPath: string,
): Promise<void> {
  const state = await context.storageState();
  const tempPath = path.join(
    path.dirname(outputPath),
    `.${path.basename(outputPath)}.${randomUUID()}.tmp`,
  );
  try {
    await fs.writeFile(tempPath, JSON.stringify(state, null, 2), {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await fs.chmod(tempPath, 0o600);
    await fs.rename(tempPath, outputPath);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}
