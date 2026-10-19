// Test entry shim. Node 22 treats `node --test <directory>` as "run this path as a
// module" and resolves a directory to its index.js, so this file makes
// `node --test tools/homepage-studio` work: it runs every tests/*.node-test.mjs file
// in a child `node --test` and mirrors the exit code. (On Node 20 the directory is
// scanned recursively and this shim is not used.) No other code lives here.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "tests");
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".node-test.mjs")).map((f) => path.join(dir, f));
const res = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
process.exit(res.status === null ? 1 : res.status);
