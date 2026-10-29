// Fixed-directory resolution extracted from merge-readback. Never search PATH.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export function assertSupportedPlatform(platform = process.platform, binary = "git") {
  if (platform === "win32") throw new Error(`${binary} runs on Linux or macOS only; on Windows run it inside WSL (fixed POSIX binary paths)`);
}

export function resolveFixedBinary(name, { dirs, exists = fs.existsSync, platform = process.platform } = {}) {
  assertSupportedPlatform(platform, name);
  const found = dirs.map((dir) => path.join(dir, name)).find((candidate) => exists(candidate));
  if (!found) throw new Error(`${name} not found in ${dirs.join(", ")}`);
  return found;
}

// Ask git for the tree entry first: a missing file is empty successful output.
// A failed show (including exit 1/128) is never evidence that a file is absent.
export function readGitFile(binary, root, ref, file) {
  assertSupportedPlatform(process.platform, "git");
  const options = { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 };
  const entries = execFileSync(binary, ["ls-tree", "-z", ref, "--", `:(literal)${file}`], options);
  if (!entries) return null;
  return execFileSync(binary, ["show", `${ref}:${file}`], options);
}
