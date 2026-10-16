// QA handoff gate (OVD-865). Pure logic, no IO and no dependencies, shared by
// the qa-handoff workflow and the Mac mini backstop (scripts/qa-handoff/run.mjs).
//
// A PR is handed off to QA once, per head sha, when every check below holds:
// the PR is open, not a draft, and targets main; the sha the caller looked up
// is still the PR head; and every required check on that sha finished as
// success, skipped or neutral. The hidden marker comment records the handoff
// so a duplicate event or the backstop finds it and does nothing.

// Fallback for when branch protection cannot be read (the workflow's
// GITHUB_TOKEN has no administration scope, so it gets 403/404). Mirrors the
// main branch protection contexts as of OVD-865: the `ci` aggregate job in
// ci.yml and `provider-go-live` in pr-body-gate.yml. Override with the
// REQUIRED_CHECKS env (comma separated) when protection changes.
export const DEFAULT_REQUIRED_CHECKS = Object.freeze(["ci", "provider-go-live"]);

export const BASE_BRANCH = "main";
export const QA_READY_LABEL = "qa:ready";

const PASSING_CONCLUSIONS = new Set(["success", "skipped", "neutral"]);

export function markerFor(sha) {
  return `<!-- qa-handoff sha=${sha} -->`;
}

export function hasMarker(comments, sha) {
  const marker = markerFor(sha);
  return (comments ?? []).some((comment) => typeof comment?.body === "string" && comment.body.includes(marker));
}

export function dedupeKey(pr, sha) {
  return `qa-handoff:${pr}:${sha}`;
}

export function parseRequiredChecks(value) {
  if (typeof value !== "string") return [];
  return [...new Set(value.split(",").map((name) => name.trim()).filter(Boolean))];
}

// Latest check run per name: a re-run creates a new check run with a higher id
// on the same sha, and only the newest one counts.
function latestCheckRuns(checkRuns) {
  const byName = new Map();
  for (const run of checkRuns ?? []) {
    const current = byName.get(run.name);
    if (!current || Number(run.id) > Number(current.id)) byName.set(run.name, run);
  }
  return byName;
}

// Latest commit status per context. The combined status endpoint already
// returns one per context; raw status lists are newest first, so keep the first.
function latestStatuses(statuses) {
  const byContext = new Map();
  for (const status of statuses ?? []) {
    if (!byContext.has(status.context)) byContext.set(status.context, status);
  }
  return byContext;
}

// Returns { state: "pass" | "pending" | "fail" | "missing", detail }.
export function requiredCheckState(name, checkRuns, statuses) {
  const run = latestCheckRuns(checkRuns).get(name);
  if (run) {
    if (run.status !== "completed") return { state: "pending", detail: `check run ${run.status}` };
    if (PASSING_CONCLUSIONS.has(run.conclusion)) return { state: "pass", detail: `check run ${run.conclusion}` };
    return { state: "fail", detail: `check run ${run.conclusion}` };
  }
  const status = latestStatuses(statuses).get(name);
  if (status) {
    if (status.state === "success") return { state: "pass", detail: "status success" };
    if (status.state === "pending") return { state: "pending", detail: "status pending" };
    return { state: "fail", detail: `status ${status.state}` };
  }
  return { state: "missing", detail: "no check run or status" };
}

// event: { headSha } — the sha the caller is evaluating (workflow_run head_sha,
// or the PR head the backstop read). pr: the PR as re-read from the API.
export function evaluateGate({ event, pr, checkRuns, statuses, requiredChecks }) {
  if (!pr) return { handoff: false, reason: "pr-not-found" };
  if (pr.state !== "open") return { handoff: false, reason: `pr-${pr.state ?? "not-open"}` };
  if (pr.draft) return { handoff: false, reason: "pr-draft" };
  const base = pr.base?.ref;
  if (base !== BASE_BRANCH) return { handoff: false, reason: `base-not-${BASE_BRANCH}:${base}` };
  const headSha = pr.head?.sha;
  if (!event?.headSha || event.headSha !== headSha) {
    return { handoff: false, reason: "stale-sha", detail: `event ${event?.headSha} != head ${headSha}` };
  }
  if (!Array.isArray(requiredChecks) || requiredChecks.length === 0) {
    return { handoff: false, reason: "no-required-checks" };
  }
  const checks = requiredChecks.map((name) => ({ name, ...requiredCheckState(name, checkRuns, statuses) }));
  const blocking = checks.filter((check) => check.state !== "pass");
  if (blocking.length > 0) {
    const order = ["fail", "pending", "missing"];
    const worst = order.find((state) => blocking.some((check) => check.state === state));
    return { handoff: false, reason: `check-${worst}`, checks };
  }
  return { handoff: true, reason: "all-required-green", checks };
}

// Gate plus the idempotency marker: the marker for this sha means the handoff
// already happened, so the answer is a no-op whatever the gate says.
export function decide({ event, pr, checkRuns, statuses, requiredChecks, comments }) {
  const key = dedupeKey(pr?.number ?? event?.prNumber, event?.headSha);
  const gate = evaluateGate({ event, pr, checkRuns, statuses, requiredChecks });
  if (!gate.handoff) return { ...gate, key };
  if (hasMarker(comments, event.headSha)) return { handoff: false, reason: "already-handed-off", key, checks: gate.checks };
  return { ...gate, key };
}
