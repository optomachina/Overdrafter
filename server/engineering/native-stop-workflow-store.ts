import { constants } from "node:fs";
import { open, realpath, stat, link, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { NativeStopFailure } from "./native-stop-admission.ts";

const LIMIT = 1800000;
/** Private server POSIX spool, not a Windows companion/DPAPI replacement.
 * The operator supplies an already existing private root; no ACL repair or
 * directory provisioning. Immutable links arbitrate concurrent identical calls.
 * A crashed pending file is never interpreted as published evidence. */
export function createNativeStopWorkflowStore(root: string) {
  const folder = resolve(root);
  async function checkRoot() {
    const info = await stat(folder);
    if (typeof process.getuid !== "function" || info.uid !== process.getuid() || !info.isDirectory()
      || (info.mode & 0o777) !== 0o700 || await realpath(folder) !== folder) {
      throw new NativeStopFailure(503, "stop_spool_not_private");
    }
  }
  function path(key: string) {
    if (!/^[0-9a-f-]{36}-[1-9][0-9]{0,15}\.(packet|evidence|request|receipt)\.json$/.test(key)) throw new NativeStopFailure(400, "invalid_spool_key");
    return join(folder, key);
  }
  async function read(key: string): Promise<string | null> {
    await checkRoot(); let file;
    try { file = await open(path(key), constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    try {
      const info = await file.stat();
      if (!info.isFile() || info.uid !== process.getuid!() || (info.mode & 0o777) !== 0o600 || info.size < 1 || info.size > LIMIT) {
        throw new NativeStopFailure(503, "stop_spool_invalid");
      }
      const bytes = await file.readFile();
      if (bytes.byteLength !== info.size || bytes.byteLength > LIMIT) throw new NativeStopFailure(503, "stop_spool_invalid");
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } finally { await file.close(); }
  }
  async function publish(key: string, value: string) {
    await checkRoot();
    const bytes = Buffer.from(value, "utf8");
    if (!bytes.byteLength || bytes.byteLength > LIMIT) throw new NativeStopFailure(400, "stop_spool_bound");
    const final = path(key), temporary = join(folder, `${randomUUID()}.pending`);
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    try {
      try { await link(temporary, final); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      if (await read(key) !== value) throw new NativeStopFailure(409, "stop_spool_conflict");
      const directory = await open(folder, constants.O_RDONLY);
      try { await directory.sync(); } finally { await directory.close(); }
    } finally { await unlink(temporary); }
  }
  return { read, publish };
}
