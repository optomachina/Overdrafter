// Turns a finished generation attempt into storage records. Shared by the
// in-process job manager and the hosted worker, so history is identical.
import { appendVersion } from "./ops.mjs";
import { assetPathFor, logPathFor } from "./paths.mjs";
import { checkAsset } from "./assetcheck.mjs";
import { lintCopy, lintContextForField } from "./lint.mjs";
import { DEMO_LABEL } from "./engines/errors.mjs";

export const RECOVERY = {
  failed: "Retry, switch tool, or use Retry with demo engine.",
  timed_out: "Retry with a smaller prompt, switch tool, or use Retry with demo engine.",
  cancelled: "Retry when ready.",
  blocked: "Fix the blocker named above, then Retry. Or use Retry with demo engine.",
};

/**
 * outcome: {state, message, text?, assetHtml?, model, usage, demo, log}
 * Returns the final job record that was stored.
 */
export async function finalizeJob(storage, job, outcome, { now = () => new Date(), idGen } = {}) {
  const finishedAt = now().toISOString();
  let state = outcome.state;
  let message = outcome.message || "";
  let lintWarnings = [];
  let candidateText = outcome.text;

  if (state === "succeeded" && job.kind === "asset") {
    const problems = checkAsset(outcome.assetHtml);
    if (problems.length) {
      state = "failed";
      message = `The output did not meet the asset contract: ${problems.join(" ")}`;
    }
  }

  const base = { ...job, state, message, finishedAt, recovery: RECOVERY[state] || "", demo: !!outcome.demo };
  if (state === "blocked") return storage.update(`blocked ${job.kind} ${job.sectionId} ${job.id}`, () => ({ jobs: [base], result: base }));

  return storage.update(`${state === "succeeded" ? "generated" : "failed"} ${job.sectionId} ${job.versionId}`, (draft) => {
    const field = job.kind === "copy" ? draft.fields[job.fieldId] : null;
    if (job.kind === "copy" && !field) throw Object.assign(new Error("Field no longer exists."), { status: 404 });
    if (state === "succeeded" && job.kind === "copy") {
      const lint = lintCopy(candidateText, lintContextForField(draft, field));
      if (lint.errors.length) {
        state = "failed";
        message = `Generated copy was blocked by copy lint: ${lint.errors.map((e) => e.message).join(" ")}`;
      } else lintWarnings = lint.warnings.map((w) => w.message);
    }
    const entity = job.kind === "copy" ? field : draft.assets[`asset-${job.sectionId}`];
    const type = job.kind;
    const common = {
      id: job.versionId,
      prompt: job.prompt,
      tool: job.tool,
      engine: job.engine,
      model: outcome.model || "unknown",
      usage: outcome.usage ?? null,
      author: "agent",
    };
    const files = [];
    let rec;
    const noteDemo = outcome.demo ? `${DEMO_LABEL}. ` : "";
    if (state === "succeeded") {
      const partial = { ...common, kind: "generated", note: `${noteDemo}Job ${job.id}`.trim() };
      if (lintWarnings.length) partial.lint = { warnings: lintWarnings };
      if (type === "copy") partial.text = candidateText;
      else {
        partial.assetPath = assetPathFor(job.sectionId, job.versionId);
        files.push({ path: partial.assetPath, content: outcome.assetHtml });
      }
      rec = appendVersion(entity, partial, { idGen, now });
    } else {
      const logPath = logPathFor(job.sectionId, job.versionId);
      files.push({ path: logPath, content: String(outcome.log || message || "") });
      const partial = { ...common, kind: "failed", note: `${noteDemo}${state}: ${message}`.slice(0, 600), logPath };
      if (type === "copy") partial.text = candidateText || "";
      else partial.assetPath = null;
      rec = appendVersion(entity, partial, { idGen, now });
    }
    const final = { ...base, state, message, recovery: RECOVERY[state] || "", resultVersionId: rec.id };
    return { result: final, files, jobs: [final] };
  });
}
