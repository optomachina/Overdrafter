const m = await import("/workspace/qa-batch/wt807-r4/scripts/emit-verdict.mjs");
const cwd = "/tmp/rif/repo"; const env = { RUNNER_TEMP: "/tmp/rif/rt" };
const cases = [
 ["FIFO", "sub/pipe.json"], ["directory", "sub/dir.json"],
 ["symlink -> FIFO (direct)", "sub/l-pipe.json"], ["symlink -> dir (direct)", "sub/l-dir.json"],
 ["symlinked parent -> FIFO", "viadir/pipe.json"], ["symlinked parent -> dir", "viadir/dir.json"],
 ["FIFO under RUNNER_TEMP", "/tmp/rif/rt/pipe.json"],
 ["regular file", "sub/ok.json"], ["regular file under RUNNER_TEMP", "/tmp/rif/rt/ok.json"],
 ["symlink -> regular (direct)", "sub/l-ok.json"], ["symlinked parent -> regular", "viadir/ok.json"],
 ["outside (absolute)", "/tmp/rif/outside/ok.json"], ["outside via ../", "../outside/ok.json"],
 ["outside via symlinked parent", "outlink/ok.json"], ["symlink -> outside file", "sub/l-out.json"],
 ["missing", "sub/nope.json"],
];
for (const [name, f] of cases) {
  const t = Date.now();
  try { const r = m.resolveInputFile(f, { cwd, env }); console.log(name.padEnd(32), "OK ->", r, `${Date.now()-t}ms`); }
  catch (e) { console.log(name.padEnd(32), "THROW:", e.message.replace(/^--findings "[^"]*" /, ""), `${Date.now()-t}ms`); }
}
