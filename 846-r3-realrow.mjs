// One real Jev call through the PR head's screen(), with an in-memory marker store (no gh, nothing written to GitHub).
const WT = process.env.QA_WT ?? "/workspace/qa-batch/wt846-r3";
const S = await import(`${WT}/scripts/jev-pr-screen.mjs`);
const [input] = JSON.parse((await import("node:fs")).readFileSync("/workspace/qa-batch/846-r3-jev-input.json", "utf8"));
const store = new Map(); const writes = [];
const marker = {
  headSha: async () => input.sha,
  read: async (sha, model, q) => (store.has(sha) ? { found: true, ...store.get(sha) } : { found: false, reason: "no_marker" }),
  write: async (sha, m) => { writes.push(sha); store.set(sha, { ...m, screener: "mjs" }); return { success: true }; },
};
const log = "/workspace/qa-batch/846-r3-real-rows.jsonl";
const [a] = await S.screen([input], { log, marker, caller: "qa-846-r3", baseRef: "origin/main" });
const [b] = await S.screen([input], { log, marker, caller: "qa-846-r3", baseRef: "origin/main" });
console.log(JSON.stringify({ first: { cache_hit: a.cache_hit, head_sha: a.head_sha, tokens: a.tokens, latency_ms: a.latency_ms, final: a.final, ok: a.ok }, second: { cache_hit: b.cache_hit, tokens: b.tokens, latency_ms: b.latency_ms, final: b.final }, writes }));
