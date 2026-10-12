import { createHash } from "node:crypto";
/** Capture once; Docker receives the exact bytes whose digest is recorded. No staging-file reread. */
export function transferCliInput(exec, container, path, input) {
  const bytes = Buffer.from(input);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  exec(container, ["sh", "-c", 'umask 077; cat > "$1" && chmod 400 "$1"', "cli-input", path], bytes);
  const actual = exec(container, ["sha256sum", path]).stdout.trim().split(/\s+/)[0];
  if (actual !== sha256) throw new Error("cli_transferred_input_mismatch");
  return { path, bytes: bytes.length, sha256 };
}
