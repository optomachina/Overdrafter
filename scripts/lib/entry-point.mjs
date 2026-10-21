// Compare canonical paths so CLI entry guards work through symlinks.
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function isEntryPoint(importMetaUrl, argv1 = process.argv[1]) {
  if (typeof argv1 !== "string" || argv1 === "") return false;
  let modulePath;
  try { modulePath = realpathSync.native(fileURLToPath(importMetaUrl)); } catch { return false; }
  let entryPath;
  try { entryPath = realpathSync.native(path.resolve(argv1)); }
  catch {
    // argv1 names this file but no longer resolves: the CLI was meant to run.
    if (path.basename(argv1) === path.basename(modulePath)) {
      process.stderr.write(`entry-point: ENTRY_POINT_MISMATCH ${argv1} did not resolve; refusing to exit 0\n`);
      process.exitCode = 70;
    }
    return false;
  }
  return process.platform === "win32" ? entryPath.toLowerCase() === modulePath.toLowerCase() : entryPath === modulePath;
}
