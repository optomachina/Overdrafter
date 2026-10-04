/**
 * Minimal advisory Jev (TypeSafe System One) client for agent-side decisions.
 *
 * Authentication: in Claude Code cloud sessions the agent proxy injects the
 * TypeSafe credential for api.typesafe.ai, so no key is read or sent here.
 * Elsewhere, an existing TYPESAFE_API_KEY is forwarded if already present.
 * Node fetch only honors HTTPS_PROXY when run with NODE_USE_ENV_PROXY=1.
 *
 * Every call returns a result object and never throws, so callers can fall
 * back to ordinary reasoning or deterministic tools. Jev output is advisory:
 * it is never an authorization, acceptance result, or filter on required
 * instructions or evidence.
 */
export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const JEV_MODEL = "jev-1.13.0";

export async function askJev(state, questions, options = {}) {
  const { endpoint = JEV_ENDPOINT, model = JEV_MODEL, timeoutMs = 10_000 } = options;
  const headers = { "Content-Type": "application/json" };
  if (process.env.TYPESAFE_API_KEY) headers.Authorization = `Bearer ${process.env.TYPESAFE_API_KEY}`;
  const started = performance.now();
  const latency = () => Math.round(performance.now() - started);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ state, model, questions }),
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
    if (body.model !== model) return { ok: false, reason: "unexpected_model_version", model: body.model, latencyMs: latency() };
    for (const id of Object.keys(questions)) {
      if (body.answers?.[id]?.type !== questions[id].type) return { ok: false, reason: "malformed_response", latencyMs: latency() };
    }
    return { ok: true, model: body.model, answers: body.answers, usage: body.usage ?? null, latencyMs: latency() };
  } catch (error) {
    const reason = error?.name === "TimeoutError" ? "timeout" : `network_${error?.cause?.code ?? error?.name ?? "error"}`;
    return { ok: false, reason, latencyMs: latency() };
  }
}

/** Accept a Choice answer only above a confidence floor; otherwise report uncertainty. */
export function gatedChoice(result, id, minConfidence = 0.5) {
  if (!result.ok) return { status: "failed", reason: result.reason };
  const answer = result.answers[id];
  if (answer.confidence < minConfidence) return { status: "uncertain", choice: answer.choice, confidence: answer.confidence };
  return { status: "accepted", choice: answer.choice, confidence: answer.confidence };
}
