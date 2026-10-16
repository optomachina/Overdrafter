/**
 * Jev PR risk screen (advisory). Sizes review: low stops after an independent
 * QA or Sonnet review, normal gets a Sonnet review, risky gets an Opus review. Jev can only raise the tier set by
 * the deterministic sensitive-path match (OVD-873: any file matching docs/sensitive-paths.json through
 * scripts/lib/sensitive-paths.mjs raises the declared tier to "risky"); a failed or low-confidence Jev call
 * raises the tier to at least "normal", and an unknown deterministic tier counts
 * as "risky". Every decision is appended to the JSONL
 * log with Jev's confidence and incident probability so rule changes can be
 * replayed over past decisions.
 *
 * Usage: NODE_USE_ENV_PROXY=1 node scripts/jev-pr-screen.mjs <input.json> [log.jsonl]
 * input.json: [{ pr, sha, title, files: [...], additions?, deletions?, deterministic: "low"|"normal"|"risky", notes? }]
 */
import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { askJev, gatedChoice, sanitizeToken } from "./jev-client.mjs";
import { classifyPaths, loadSensitivePaths } from "./lib/sensitive-paths.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
export const DEFAULT_LOG = fileURLToPath(new URL("../docs/agent-log/jev-decisions.jsonl", import.meta.url));
export const TIERS = ["low", "normal", "risky"];
export const DEFAULT_MIN_CONFIDENCE = 0.5;
const MAX_CONCURRENT_CALLS = 4;

const isProbability = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
const floorOf = (value) => (isProbability(value) ? value : DEFAULT_MIN_CONFIDENCE);

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

/** The higher of two known tiers. */
export function maxTier(a, b) {
  return TIERS.indexOf(b) > TIERS.indexOf(a) ? b : a;
}

/**
 * Combine the deterministic tier with a gated Jev answer. Jev may only raise risk.
 * An unknown deterministic tier (a typo such as "Risky") counts as "risky", and an
 * unknown or unaccepted Jev tier counts as "normal", so no typo lowers review.
 */
export function finalTier(deterministic, gate) {
  const base = TIERS.includes(deterministic) ? deterministic : "risky";
  const jevTier = gate?.status === "accepted" && TIERS.includes(gate.choice) ? gate.choice : "normal";
  return maxTier(base, jevTier);
}

/**
 * Deterministic tier: the declared tier (unknown counts as risky), raised to
 * risky when any file is on the shared sensitive-path list. Never lowers.
 */
export function deterministicTier(pr, sensitivePaths = null) {
  const declared = TIERS.includes(pr.deterministic) ? pr.deterministic : "risky";
  if (!sensitivePaths || !Array.isArray(pr.files)) return { tier: declared, sensitiveClasses: null };
  const { sensitive, classes } = classifyPaths(pr.files.map(String), sensitivePaths);
  return { tier: sensitive ? "risky" : declared, sensitiveClasses: classes };
}

export function decisionRecord(pr, result, now = new Date(), { minConfidence = DEFAULT_MIN_CONFIDENCE, sensitivePaths = null } = {}) {
  const gate = gatedChoice(result, "tier", floorOf(minConfidence));
  const { tier: deterministic, sensitiveClasses } = deterministicTier(pr, sensitivePaths);
  const incident = result?.ok ? result.answers?.incident?.noul : undefined;
  return {
    ts: now.toISOString(),
    kind: "pr_risk_screen",
    pr: Number.isInteger(pr.pr) ? pr.pr : null,
    sha: sanitizeToken(pr.sha),
    model: result?.ok ? sanitizeToken(result.model) : null,
    ok: result?.ok === true,
    reason: result?.ok ? null : (sanitizeToken(result?.reason) ?? "no_result"),
    jev: {
      tier: TIERS.includes(gate.choice) ? gate.choice : null,
      confidence: isProbability(gate.confidence) ? gate.confidence : null,
      status: gate.status,
      pIncident: isProbability(incident) ? incident : null,
    },
    deterministic,
    sensitiveClasses,
    final: finalTier(deterministic, gate),
    latencyMs: Number.isFinite(result?.latencyMs) ? result.latencyMs : null,
  };
}

/** Recompute final tiers from logged decisions under a different confidence floor (rule replay). */
export function replay(records, { minConfidence = DEFAULT_MIN_CONFIDENCE } = {}) {
  const floor = floorOf(minConfidence);
  return records.map((record) => {
    const { tier, confidence } = record.jev ?? {};
    const accepted = record.ok === true && isProbability(confidence) && confidence >= floor;
    const final = finalTier(record.deterministic, accepted ? { status: "accepted", choice: tier } : { status: "uncertain" });
    return { pr: record.pr, sha: record.sha, before: record.final, after: final, changed: final !== record.final };
  });
}

export async function screen(prs, { ask = askJev, log = DEFAULT_LOG, append = appendFileSync, minConfidence = DEFAULT_MIN_CONFIDENCE, sensitivePaths = loadSensitivePaths({ root: REPO_ROOT }) } = {}) {
  const results = [];
  // A few calls at a time; titles, paths and notes leave the box, so keep the batch bounded.
  for (let start = 0; start < prs.length; start += MAX_CONCURRENT_CALLS) {
    const chunk = prs.slice(start, start + MAX_CONCURRENT_CALLS).map((pr) => {
      const state = { title: pr.title, files: pr.files, additions: pr.additions ?? null, deletions: pr.deletions ?? null, notes: pr.notes ?? "" };
      return ask(state, SCREEN_QUESTIONS, { timeoutMs: 20_000 });
    });
    results.push(...(await Promise.all(chunk)));
  }
  // Append in input order so the log reads like the batch.
  const records = prs.map((pr, index) => decisionRecord(pr, results[index], new Date(), { minConfidence, sensitivePaths }));
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
