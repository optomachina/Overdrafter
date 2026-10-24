import { createRequire, syncBuiltinESMExports } from "node:module";
import { appendFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const cp = require("node:child_process");
const LOG = process.env.GHSPY_LOG;
appendFileSync(LOG, `loaded pid=${process.pid}\n`);
for (const name of ["execFileSync", "execFile", "spawn", "spawnSync", "exec", "execSync"]) {
  const orig = cp[name];
  cp[name] = function (file, ...rest) {
    const cmd = String(file);
    const args = Array.isArray(rest[0]) ? rest[0].join(" ") : "";
    if (/(^|\/)gh(\s|$)/.test(cmd) || /(^|[\s/])gh\s/.test(cmd)) appendFileSync(LOG, `GH ${name} pid=${process.pid} ${cmd} ${args.slice(0, 120)}\n`);
    return orig.call(this, file, ...rest);
  };
}
syncBuiltinESMExports();
