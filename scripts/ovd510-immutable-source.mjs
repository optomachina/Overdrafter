/** Private, read-only Git export for the complete OVD570 rehearsal. */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const git = (root, args) => execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
const manifestBytes = (manifest) => JSON.stringify(manifest, null, 2) + "\n";

function walk(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error("immutable_source_symlink");
    if (entry.isDirectory()) return [path, ...walk(path)];
    if (!entry.isFile()) throw new Error("immutable_source_nonregular_file");
    return [path];
  });
}

/** Export committed bytes before fixture admission; all later imports/reads use this root. */
export async function withImmutableSource(repositoryRoot, callback, { cli = false } = {}) {
  if (git(repositoryRoot, ["status", "--porcelain", "--untracked-files=no"]).trim()) {
    throw new Error("immutable_source_requires_clean_checkout");
  }
  const sourceRevision = git(repositoryRoot, ["rev-parse", "HEAD^{commit}"]).trim();
  const objectFormat = git(repositoryRoot, ["rev-parse", "--show-object-format"]).trim();
  const tree = git(repositoryRoot, ["ls-tree", "-rz", sourceRevision]).split("\0").filter(Boolean);
  if (tree.some((entry) => !/^(100644|100755) blob [a-f0-9]+\t/.test(entry))) throw new Error("immutable_source_unsupported_git_entry");
  const temporary = mkdtempSync(join(tmpdir(), "ovd570-immutable-"));
  const root = join(temporary, "source");
  try {
    mkdirSync(root, { mode: 0o700 });
    const archive = execFileSync("git", ["archive", "--format=tar", sourceRevision], {
      cwd: repositoryRoot, maxBuffer: 128 * 1024 * 1024,
    });
    execFileSync("tar", ["-x", "-C", root], { input: archive });
    const files = {};
    for (const entry of tree) {
      const [header, path] = entry.split("\t");
      const [mode, type, oid] = header.split(" ");
      if (type !== "blob" || !["100644", "100755"].includes(mode)) throw new Error("immutable_source_unsupported_git_entry");
      const fullPath = join(root, path);
      if (!lstatSync(fullPath).isFile()) throw new Error("immutable_source_nonregular_file");
      const bytes = readFileSync(fullPath);
      const actualOid = createHash(objectFormat).update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
      if (actualOid !== oid) throw new Error(`immutable_source_export_mismatch:${path}`);
      files[path] = sha256(bytes);
    }
    // The CLI is an optional external input, copied once from already authorized local evidence.
    const assets = {};
    if (cli) {
      const name = "supabase_linux_arm64.tar.gz";
      const bytes = readFileSync(join(repositoryRoot, "..", "evidence", "ovd570-linux-cli", name));
      const digest = sha256(bytes);
      if (digest !== "b3d941c1aefbe469db17af1a12373c8a9176e24b9f9499bd509477e5be598501") throw new Error("linux_cli_archive_hash_mismatch");
      const destination = join(temporary, "evidence", "ovd570-linux-cli");
      mkdirSync(destination, { recursive: true, mode: 0o700 });
      writeFileSync(join(destination, name), bytes, { mode: 0o400, flag: "wx" });
      assets[`evidence/ovd570-linux-cli/${name}`] = digest;
    }
    const paths = walk(root);
    if (paths.filter((path) => lstatSync(path).isFile()).length !== Object.keys(files).length) throw new Error("immutable_source_extra_file");
    for (const path of paths.reverse()) chmodSync(path, lstatSync(path).isDirectory() ? 0o500 : 0o400);
    chmodSync(root, 0o500);
    const manifest = { schema: "immutable-sql-source.v1", sourceRevision,
      archiveSha256: sha256(archive), files, assets };
    const verifySource = () => {
      const actualFiles = walk(root).filter((path) => lstatSync(path).isFile());
      if (actualFiles.length !== Object.keys(files).length) throw new Error("immutable_source_inventory_changed");
      for (const [path, digest] of Object.entries(files)) {
        const fullPath = join(root, path);
        if ((lstatSync(fullPath).mode & 0o222) || sha256(readFileSync(fullPath)) !== digest) throw new Error(`immutable_source_changed:${path}`);
      }
      for (const [path, digest] of Object.entries(assets)) {
        if (sha256(readFileSync(join(temporary, path))) !== digest) throw new Error(`immutable_asset_changed:${path}`);
      }
    };
    verifySource();
    const result = await callback({ root, repositoryRoot, sourceRevision, sourceManifest: manifest,
      sourceManifestSha256: sha256(manifestBytes(manifest)), verifySource });
    verifySource();
    return result;
  } finally {
    // Only the exclusively created export is removed; original checkout/evidence stay intact.
    const unlockDirectories = (path) => {
      chmodSync(path, 0o700);
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        if (entry.isDirectory()) unlockDirectories(join(path, entry.name));
      }
    };
    unlockDirectories(temporary);
    rmSync(temporary, { recursive: true, force: true });
  }
}
