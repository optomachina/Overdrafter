# Simulated Jev routing gate and failure evidence

OVD-556, source-only evaluation on the frozen OVD-555 42-case synthetic corpus.
The answers in this package are **simulated adapter signals derived from the
human labels**, not Jev outputs. No API call, credential, database mutation,
native execution, or queue admission occurred. This package tests the proposed
failure boundary while an authorized server-side Jev credential remains absent.

## Reproduce

From the repository root after `npm ci`, run:

```bash
./node_modules/.bin/vite-node scripts/jarvis-jev-simulated-gates.ts
```

The script reads `jev-synthetic-cases.jsonl` and the current prepared assembly
fixture, then rewrites `jev-simulated-gate-results.jsonl` and
`jev-simulated-gate-summary.json`. Each record includes the expected label,
simulated signal, legacy interpreter route, deterministic gate reason, proposed
application action, and explicit `executed: false`. Returned model version,
confidence, latency, tokens, and cost remain `null` because none were observed.
No confidence threshold is inferred from simulated answers.

## Gate and observed results

The local gate first checks the synthetic conversation revision and predecessor
token. It treats timeout, rate limit, malformed signal, and wrong model version
as recoverable blocks. A clarification signal asks for one unconditional final
depth in millimeters for the baseline part. An unsupported signal explains
non-support. A supported signal still needs an existing prepared interpreter
proposal, the validated current prepared context, an exact predecessor token,
and fewer than five outstanding changes. A disagreement asks for clarification;
it does not create a waiting intent. The script never calls the queue.

The 42 labeled signals produced seven **would-record-waiting** outcomes, zero
unsafe waiting outcomes, and zero accepted-depth mismatches against the frozen
labels. The labels are used for this after-the-fact assertion, never to grant
the waiting action. Three otherwise supported paraphrases (`C04`,
`C06`, `C08`) were rejected by the existing interpreter, exposing false
rejections that a future model result alone cannot override. `C42` was blocked
at the five-outstanding limit. All ten injected failure cases, including null
and missing adapter responses, stayed
recoverable and unexecuted. In addition, each of the 31 ambiguous or unsupported
requests was re-evaluated with a deliberately wrong simulated
`supported_depth_change` signal; none became a waiting intent.

This evidence proves only the local adapter-signal simulation against the
frozen corpus. The corpus has a synthetic predecessor token, not a full queue
lineage or competing database transaction. It does not measure Jev accuracy,
distribution, model version, latency, tokens, cost, or the integrated execution
path. The later live evaluation must record those observed values, review false
rejections and false accepts, and prove the deterministic database/native gates
separately before any runtime pilot is proposed.
