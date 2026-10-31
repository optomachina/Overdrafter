import { headDiffId } from "/home/user/Overdrafter/scripts/ovd-merge-gate.mjs";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
const before = readdirSync(tmpdir()).filter((n) => n.startsWith("ovd-merge-gate-data-"));
const t0 = Date.now();
const r = headDiffId({ pr: 972, repo: "optomachina/Overdrafter", headSha: "37f83a69dea8721cb7d2ef137d39d9b12685da00", baseRef: "main", cwd: process.cwd() });
const after = readdirSync(tmpdir()).filter((n) => n.startsWith("ovd-merge-gate-data-"));
console.log(JSON.stringify({ git: process.versions.node && "see below", result: r, ms: Date.now() - t0, leftoverStores: after.filter((n) => !before.includes(n)) }, null, 2));
