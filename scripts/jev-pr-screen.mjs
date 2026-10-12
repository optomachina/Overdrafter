/**
 * Jev PR risk screen (advisory). Sizes review: low stops after QA, normal gets a
 * Sonnet review, risky gets an Opus review. Jev can only raise the tier set by
 * the deterministic sensitive-path match; a failed or low-confidence Jev call
 * raises the tier to at least "normal". Every decision is appended to the JSONL
 * log with Jev's confidence and incident probability so rule changes can be
 * replayed over past decisions.
 *
 * Usage: NODE_USE_ENV_PROXY=1 node scripts/jev-pr-screen.mjs <input.json> [log.jsonl]
 * input.json: [{ pr, sha, title, files: [...], additions?, deletions?, deterministic: "low"|"normal"|"risky", notes? }]
 */
import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { askJev, gatedChoice } from "./jev-client.mjs";

export const DEFAULT_LOG = "docs/agent-log/jev-decisions.jsonl";
export const TIERS = ["low", "normal", "risky"];

export const SCREEN_QUESTIONS = {
  tier: {
    type: "choice",
    instructions:
      "Classify the review risk of this pull request for a quoting SaaS (Supabase, worker that automates provider quote sites). Consider blast radius, security, data, money, provider dispatch, CI and deploy.",
    criteria: {
      low: "Docs, tests, UI polish, or isolated tooling with no runtime, security, data or money effect.",
      normal: "Runtime code with bounded blast radius and good tests; no auth, RLS, migrations, secrets, money, deploy or provider dispatch semantics.",
      risky: "Touches auth, RLS, SQL, migrations, secrets, billing, deploy, CI gates, provider dispatch, or guardrails other agents rely on.",
    },
  },
  incident: {
    type: "noul",
    instructions:
      "Probability that merging this PR as is causes a production incident, security exposure, or a silently weakened safety gate.",
  },
};

/** The higher of two tiers; unknown values count as "normal" so a typo never lowers review. */
export function maxTier(a, b) {
  const norm = (tier) => (TIERS.includes(tier) ? tier : "normal");
  const [x, y] = [norm(a), norm(b)];
  return TIERS.indexOf(y) > TIERS.indexOf(x) ? y : x;
}

/** Combine the deterministic tier with a gated Jev answer. Jev may only raise risk. */
export function finalTier(deterministic, gate) {
  const jevTier = gate?.status === "accepted" && TIERS.includes(gate.choice) ? gate.choice : "normal";
  return maxTier(deterministic, jevTier);
}

export function decisionRecord(pr, result, now = new Date()) {
  const gate = gatedChoice(result, "tier");
  const incident = result?.ok ? result.answers?.incident?.noul : undefined;
  return {
    ts: now.toISOString(),
    kind: "pr_risk_screen",
    pr: pr.pr,
    sha: pr.sha,
    model: result?.ok ? result.model : null,
    ok: result?.ok === true,
    reason: result?.ok ? null : (result?.reason ?? "no_result"),
    jev: {
      tier: gate.choice ?? null,
      confidence: gate.confidence ?? null,
      status: gate.status,
      pIncident: typeof incident === "number" ? incident : null,
    },
    deterministic: pr.deterministic,
    final: finalTier(pr.deterministic, gate),
    latencyMs: result?.latencyMs ?? null,
  };
}

/** Recompute final tiers from logged decisions under a different confidence floor (rule replay). */
export function replay(records, { minConfidence = 0.5 } = {}) {
  return records.map((record) => {
    const { tier, confidence } = record.jev ?? {};
    const accepted = record.ok && typeof confidence === "number" && confidence >= minConfidence;
    const final = finalTier(record.deterministic, accepted ? { status: "accepted", choice: tier } : { status: "uncertain" });
    return { pr: record.pr, sha: record.sha, before: record.final, after: final, changed: final !== record.final };
  });
}

export async function screen(prs, { ask = askJev, log = DEFAULT_LOG, append = appendFileSync } = {}) {
  const results = await Promise.all(
    prs.map((pr) => {
      const state = { title: pr.title, files: pr.files, additions: pr.additions ?? null, deletions: pr.deletions ?? null, notes: pr.notes ?? "" };
      return ask(state, SCREEN_QUESTIONS, { timeoutMs: 20_000 });
    }),
  );
  // Append in input order so the log reads like the batch.
  const records = prs.map((pr, index) => decisionRecord(pr, results[index]));
  for (const record of records) append(log, `${JSON.stringify(record)}\n`);
  return records;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [input, log = DEFAULT_LOG] = process.argv.slice(2);
  const records = await screen(JSON.parse(readFileSync(input, "utf8")), { log });
  for (const r of records) {
    const failure = r.ok ? "" : ` (jev failed: ${r.reason})`;
    console.log(`#${r.pr} det=${r.deterministic} jev=${r.jev.tier}@${r.jev.confidence} p_incident=${r.jev.pIncident} -> ${r.final}${failure}`);
  }
}
