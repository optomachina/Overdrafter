/**
 * Minimal advisory Jev (TypeSafe System One) client for agent-side decisions.
 *
 * Authentication: inside the Claude Code agent proxy, the proxy injects the
 * TypeSafe credential for api.typesafe.ai and this client sends no
 * Authorization header. Outside it, set TYPESAFE_API_KEY (non empty) and the
 * client sends "Authorization: Bearer <key>". With neither, the call fails and
 * returns an advisory-unavailable result (http_403). The key is read only to
 * build that one header; it is never logged, printed, or placed in a result,
 * and results carry only fixed reason codes and sanitized tokens.
 * Node fetch only honors HTTPS_PROXY when run with NODE_USE_ENV_PROXY=1.
 *
 * Every call returns a result object and never throws, so callers can fall
 * back to ordinary reasoning or deterministic tools. Jev output is advisory:
 * it is never an authorization, acceptance result, or filter on required
 * instructions or evidence.
 *
 * Smoke: NODE_USE_ENV_PROXY=1 node scripts/jev-client.mjs --smoke
 */
import { fileURLToPath } from "node:url";

export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const JEV_MODEL = "jev-1.13.0";

/** Bound a service- or caller-supplied value to a short printable token (null when not a string). */
export function sanitizeToken(value) {
  if (typeof value !== "string") return null;
  const key = process.env.TYPESAFE_API_KEY?.trim();
  if (key && (value.includes(key) || value.replace(/[^\w.-]/g, "_").includes(key.replace(/[^\w.-]/g, "_")))) return "redacted";
  return value.replace(/[^\w.-]/g, "_").slice(0, 64);
}

const isProbability = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;

/** True when `answer` is a well-formed answer of the type and options that `question` asked for. */
export function isValidAnswer(question, answer) {
  if (!answer || typeof answer !== "object" || answer.type !== question?.type) return false;
  if (question.type === "noul") return isProbability(answer.noul);
  if (question.type === "choice") {
    const criteria = question.criteria && typeof question.criteria === "object" ? question.criteria : {};
    return isProbability(answer.confidence) && typeof answer.choice === "string" && Object.hasOwn(criteria, answer.choice);
  }
  return true;
}

function networkReason(error) {
  if (error?.name === "TimeoutError" || error?.name === "AbortError") return "timeout";
  return `network_${sanitizeToken(String(error?.cause?.code ?? error?.name ?? "error"))}`;
}

export async function askJev(state, questions, options) {
  const started = performance.now();
  const latency = () => Math.round(performance.now() - started);
  const { endpoint = JEV_ENDPOINT, model = JEV_MODEL, timeoutMs = 10_000 } = options ?? {};
  let payload;
  try {
    payload = JSON.stringify({ state, model, questions });
  } catch {
    // A BigInt or circular input is a caller error, not a network failure; never sent.
    return { ok: false, reason: "invalid_request", latencyMs: latency() };
  }
  const headers = { "Content-Type": "application/json" };
  const apiKey = process.env.TYPESAFE_API_KEY?.trim();
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: payload,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    if (!response.ok) return { ok: false, reason: `http_${response.status}`, latencyMs: latency() };
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return { ok: false, reason: "malformed_response", latencyMs: latency() };
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, reason: "malformed_response", latencyMs: latency() };
    if (body.model !== model) return { ok: false, reason: "unexpected_model_version", model: sanitizeToken(body.model), latencyMs: latency() };
    for (const id of Object.keys(questions ?? {})) {
      if (!isValidAnswer(questions[id], body.answers?.[id])) return { ok: false, reason: "malformed_response", latencyMs: latency() };
    }
    return { ok: true, model: body.model, answers: body.answers, usage: body.usage ?? null, latencyMs: latency() };
  } catch (error) {
    return { ok: false, reason: networkReason(error), latencyMs: latency() };
  }
}

/** Accept a Choice answer only at or above a confidence floor; otherwise report uncertainty or failure. */
export function gatedChoice(result, id, minConfidence = 0.5) {
  if (!result?.ok) return { status: "failed", reason: result?.reason ?? "no_result" };
  const answer = result.answers?.[id];
  if (!answer || typeof answer.choice !== "string" || !isProbability(answer.confidence)) {
    return { status: "failed", reason: "malformed_answer" };
  }
  if (answer.confidence < minConfidence) return { status: "uncertain", choice: answer.choice, confidence: answer.confidence };
  return { status: "accepted", choice: answer.choice, confidence: answer.confidence };
}

/** One synthetic routing question; prints model, latency, usage and the gated answer, never headers or credentials. */
export async function smoke() {
  const questions = {
    role: {
      type: "choice",
      instructions: "Which worker role should own `task`?",
      criteria: {
        implementer: "Writes or changes source code and tests for a bounded change.",
        verifier: "Runs deterministic checks, tests, and acceptance evidence for a given revision.",
      },
    },
  };
  const result = await askJev({ task: "Run the unit tests on commit abc123 and record results" }, questions);
  const gate = gatedChoice(result, "role");
  // Print only values rebuilt from this module's own constants or numbers, never raw response text.
  const count = (value) => (Number.isFinite(value) ? Number(value) : null);
  const summary = {
    ok: result.ok === true,
    reason: result.ok ? null : sanitizeToken(String(result.reason ?? "unknown")),
    model: result.model === JEV_MODEL ? JEV_MODEL : null,
    latencyMs: count(result.latencyMs),
    usage: result.usage ? { input_tokens: count(result.usage.input_tokens), output_tokens: count(result.usage.output_tokens) } : null,
    gate: {
      status: ["accepted", "uncertain", "failed"].find((s) => s === gate.status) ?? "failed",
      choice: Object.keys(questions.role.criteria).find((k) => k === gate.choice) ?? null,
      confidence: count(gate.confidence),
    },
  };
  console.log(JSON.stringify(summary, null, 2));
  return summary;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1] && process.argv.includes("--smoke")) {
  const summary = await smoke();
  process.exitCode = summary.ok ? 0 : 1;
}
