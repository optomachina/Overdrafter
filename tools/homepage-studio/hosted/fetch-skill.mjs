// Fetches a tool's skill source into the runner at a PINNED revision and verifies
// it. Fails CLOSED on any mismatch or missing pin. Uses git and curl only; no
// third-party GitHub Actions.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", ...opts });

export function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

export function fetchSkill(tool, workRoot) {
  const s = tool.source;
  if (!s) throw new Error("tool has no source");
  const dest = path.join(workRoot, `skill-${tool.id}`);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  if (s.type === "git") {
    if (!/^[0-9a-f]{40}$/.test(s.commit || "")) throw new Error("git source is not pinned to a full commit SHA");
    if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(s.repo)) throw new Error("git source must be an https://github.com/owner/name URL");
    run("git", ["init", "-q"], { cwd: dest });
    run("git", ["fetch", "-q", "--depth", "1", s.repo, s.commit], { cwd: dest });
    run("git", ["checkout", "-q", "FETCH_HEAD"], { cwd: dest });
    const head = run("git", ["rev-parse", "HEAD"], { cwd: dest }).trim();
    if (head !== s.commit) throw new Error(`fetched commit ${head} does not match the pinned ${s.commit}`);
    fs.rmSync(path.join(dest, ".git"), { recursive: true, force: true });
    return resolveSub(dest, s.subpath);
  }
  if (s.type === "zip") {
    if (!/^[0-9a-f]{64}$/.test(s.sha256 || "")) throw new Error("zip source is not pinned to a sha256");
    if (!/^https:\/\//.test(s.url)) throw new Error("zip source must be https");
    const zip = path.join(workRoot, `${tool.id}.zip`);
    run("curl", ["-fsSL", "--max-filesize", "52428800", "-o", zip, s.url]);
    const got = sha256File(zip);
    if (got !== s.sha256) throw new Error(`zip sha256 ${got} does not match the pinned ${s.sha256}`);
    run("unzip", ["-q", "-o", zip, "-d", dest]);
    return resolveSub(dest, s.subpath);
  }
  throw new Error(`unknown source type ${s.type}`);
}

function resolveSub(dest, sub) {
  const dir = path.resolve(dest, sub && sub !== "." ? sub : ".");
  if (dir !== dest && !dir.startsWith(dest + path.sep)) throw new Error("subpath escapes the skill directory");
  if (!fs.existsSync(path.join(dir, "SKILL.md"))) throw new Error("SKILL.md not found at the pinned subpath");
  return dir;
}
