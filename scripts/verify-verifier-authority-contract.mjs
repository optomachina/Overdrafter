import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const contractPath = join(root, "docs/verifier-authority-contract.md");
const execFileAsync = promisify(execFile);

export const VERIFIER_AUTHORITY_ALLOWLIST = Object.freeze([
  "public.api_load_native_verification(uuid,uuid)",
  "public.api_complete_native_verification(uuid,text)",
  "public.api_reject_native_verification(uuid,jsonb)",
  "engineering_private.load_native_verification(uuid,uuid)",
  "engineering_private.complete_native_verification(uuid,text)",
  "engineering_private.reject_native_verification(uuid,jsonb)",
  "engineering_private.native_verifier_can_read_object(text,text)",
]);

export async function verifyVerifierAuthorityContract() {
  const contract = await readFile(contractPath, "utf8");
  const start = "<!-- verifier-authority-allowlist:start -->";
  const end = "<!-- verifier-authority-allowlist:end -->";
  const startIndex = contract.indexOf(start);
  const endIndex = contract.indexOf(end);
  assert.notEqual(startIndex, -1, "allowlist start marker missing");
  assert.notEqual(endIndex, -1, "allowlist end marker missing");
  const block = contract.slice(startIndex + start.length, endIndex);
  const documented = [...block.matchAll(/^- `([^`]+)`$/gm)].map((match) => match[1]);
  assert.deepEqual(
    documented,
    VERIFIER_AUTHORITY_ALLOWLIST,
    "documented verifier allowlist changed",
  );
  assert.equal(
    new Set(documented).size,
    documented.length,
    "allowlist contains a duplicate signature",
  );

  for (const excluded of [
    "public.api_load_native_preview(uuid,uuid)",
    "public.api_complete_native_preview(uuid,text,integer)",
    "engineering_private.require_native_verifier()",
    "engineering_private.lock_verifier_attempt(uuid)",
  ]) {
    assert.equal(
      documented.includes(excluded),
      false,
      `${excluded} must remain outside the allowlist`,
    );
  }

  const sourceRoots = ["server", "src", "worker", "supabase/functions", "supabase/migrations"];
  const authorityPattern = /api_(load|complete|reject)_native_(verification|preview)|engineering_native_verifier/;
  let references = [];
  try {
    const { stdout } = await execFileAsync(
      "git",
      [
        "grep",
        "-l",
        "-E",
        authorityPattern.source,
        "--",
        ...sourceRoots,
      ],
      { cwd: root },
    );
    references = stdout.trim().split("\n").filter(Boolean).sort();
  } catch (error) {
    if (error?.code !== 1) throw error;
  }

  const { stdout: untrackedOutput } = await execFileAsync(
    "git",
    ["ls-files", "--others", "--exclude-standard", "--", ...sourceRoots],
    { cwd: root },
  );
  const untracked = untrackedOutput.trim().split("\n").filter(Boolean);
  const untrackedMatches = await Promise.all(
    untracked.map(async (path) => {
      const contents = await readFile(join(root, path), "utf8");
      return authorityPattern.test(contents) ? path : null;
    }),
  );
  references = [...new Set([...references, ...untrackedMatches.filter(Boolean)])].sort();

  assert.deepEqual(
    references,
    [],
    "current deployable source contains verifier authority; this contract must be reconciled before implementation",
  );

  for (const required of [
    "PUBLIC EXECUTE",
    "NOINHERIT",
    "SECURITY DEFINER",
    "alter default privileges for role postgres",
    "every schema in the replay",
    "Future functions",
    "Rollback and unknown-state handling",
    "TypeSafe and Jev are not authorization inputs",
  ]) {
    assert.ok(contract.includes(required), `contract is missing required boundary: ${required}`);
  }

  return Object.freeze({
    contract: relative(root, contractPath),
    allowlist: Object.freeze([...documented]),
    deployableVerifierReferences: Object.freeze([...references]),
    result: "pass",
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await verifyVerifierAuthorityContract(), null, 2));
}
