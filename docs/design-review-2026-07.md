# OverDrafter Design Review — July 2026

Scope: whole repo, with emphasis on the LLM and automation layers.
Baseline at review time: `main` @ `c8276e9`; `npm run typecheck`, `npm --prefix worker run typecheck`, and `npm run lint` all pass.

This document answers a specific question: **knowing what we know now, how should this system have been designed from the start, and what does that imply for the code that exists?** It is a design argument, not a bug list. Concrete defects appear only where they illustrate a structural cause.

---

## 1. The thesis

OverDrafter already contains the right idea, stated well, in one place.

Drawing extraction is built deterministic-first: a label-anchored parser runs, a model is called only when critical fields are missing, weak, or contested (`worker/src/extraction/modelFallback.ts:139`), and the two are merged under an explicit policy that carries confidence, evidence, provenance, and a `reviewNeeded` flag per field (`worker/src/extraction/hybridExtraction.ts:106`). Disagreement between parser and model does not resolve to a guess — it fails closed into review (`hybridExtraction.ts:176`). `ARCHITECTURE.md:197` states the principle plainly: *"Drawing extraction is advisory evidence, not the canonical quote contract."*

That is a genuinely good design. It is also the only place in the system where it exists.

**The system should have been built so that this pattern was a shared contract, not a subsystem's private habit.** Every input OverDrafter consumes that is not deterministic — model output, and equally the DOM of a vendor portal it does not control — should have flowed through the same `value + confidence + source + evidence` envelope and the same fail-closed policy. Instead the pattern was re-derived per subsystem, with decreasing rigor the further you get from the drawing pipeline. The weakest version of it guards the field that matters most commercially: the vendor price.

Nearly every finding below is a corollary of that single omission.

---

## 2. Finding 1 — the money path has no confidence model

This is the most important item in the review.

Drawing fields get confidence scoring, competing-candidate detection, and review gating. Vendor prices — the numbers that reach the customer — get a regex.

`worker/src/adapters/xometry.ts:570` tries a list of scoped locators, and when all of them miss, falls back to parsing the **entire page body**:

```ts
const fallbackValue = parser(bodyText);
return {
  value: fallbackValue,
  source: fallbackValue !== null ? "body_text" : "none",
  selector: null,
};
```

`parseFirstCurrency` (`xometry.ts:62`) returns the *first* `$N.NN` anywhere in `document.body.innerText`. `parseLeadTime` returns the first `N days`. `worker/src/adapters/fictiv.ts:599` does the same. The generic `PortalQuoteWorkflowAdapter` used by the eight hidden vendors has no scoped locator at all — whole-page scraping is its only mode (`worker/src/adapters/portalWorkflow.ts:486`).

The fallback exists for the case where the vendor changed their UI. That is precisely the case where the first dollar amount on the page is most likely to be a promo banner, a shipping threshold, a subscription CTA, or a strikethrough list price.

The code knows this. It records `priceSource: "selector" | "body_text" | "none"`. **Nothing gates on it.** The only consumer in the entire repo is a label in an internal debug card (`src/components/quotes/XometryDebugCard.tsx:328`). A `body_text` price is written to `vendor_quote_results.total_price_usd` and flows into client-facing quote comparison indistinguishably from a selector-anchored one.

### How it should have been designed

One envelope type, in the core, for every non-deterministic read — model or DOM:

```ts
type Extracted<T> = {
  value: T | null;
  confidence: number;
  source: "anchored" | "inferred" | "unanchored";
  evidence: { locator?: string; snippet?: string; artifactPath?: string };
  reviewNeeded: boolean;
};
```

and one policy function that decides what a given confidence/source combination is allowed to do. For prices the policy is not subtle: **an unanchored price is not a price.** A `body_text` hit is a signal that the adapter is broken, and the correct outcome is `manual_review_pending` plus a locator-drift alert — never a number on a customer's screen.

The drawing pipeline already implements this shape. The adapters should have been callers of it rather than parallel inventions.

> Behavior note: applying this policy will convert some currently-priced results into manual review. That is a product decision about accuracy-vs-coverage, so it is recommended here rather than applied. It is a small change — the provenance is already threaded end to end; only the gate is missing.

---

## 3. Finding 2 — production and evaluation run different code

There are two complete implementations of "call a model to extract title-block fields."

| | Production `extraction/modelFallback.ts` | Eval/Lab `tools/extractEvalProviders.ts` |
|---|---|---|
| Providers | OpenAI, OpenRouter | OpenAI, Anthropic, OpenRouter |
| `temperature` | unset | `0` (lines 127, 174, 241) |
| Token counts | not captured | captured |
| Latency / cost | not captured | captured |
| Error handling | raw `throw` → warning string | typed taxonomy (`extractEvalProviders.ts:35`) |
| OpenRouter transport | `responses.parse` | `chat.completions` + `json_schema` |

They share the prompt constants and the Zod schema, which makes the divergence easy to miss and easy to believe is smaller than it is. It is not small:

- **Production extraction is non-deterministic; the harness that measures it is deterministic.** Eval pins `temperature: 0`, production leaves it at the provider default (`modelFallback.ts:351`). Every accuracy number the eval harness produces describes a configuration that never runs for a customer.
- **Anthropic is unreachable in production.** `ANTHROPIC_API_KEY` is parsed (`config.ts:63`) and plumbed to `config.anthropicApiKey` (`config.ts:205`), but the production client builder only ever constructs OpenAI or OpenRouter (`modelFallback.ts:210`). The key is live only in the debug lab and the eval CLI. There is no cross-provider failover on the path that serves customers, despite the configuration implying one exists.
- **The two transports differ where OpenRouter is least consistent.** Production sends OpenRouter traffic through `responses.parse`; the eval provider uses `chat.completions` with a strict JSON schema. Commit `e3582a0` ("Fix OpenRouter extraction") suggests this seam has already cost time.
- The sufficiency rule is duplicated and drifting: `isModelAttemptSufficient` (`modelFallback.ts:268`) against `CRITICAL_MODEL_FIELDS`, versus `isAttemptSufficient` (`debugLab.ts:363`) against a separately declared `SUFFICIENT_FIELDS` with the 0.8 threshold inlined as a literal.

### How it should have been designed

`extractEvalProviders.ts` is, structurally, the better module — a provider interface, typed errors, usage accounting, deterministic sampling. It is in the wrong place. The provider abstraction belongs in the extraction core, with **one** implementation and three thin callers: the worker, the eval CLI, and the debug lab.

```
extraction/
  schema.ts        # Zod schema + prompt, versioned by content hash
  provider.ts      # interface ExtractionProvider { run(...): Promise<Result | TypedError> }
  providers/{openai,anthropic,openrouter}.ts
  policy.ts        # sufficiency + merge, declared once
```

The rule to have adopted on day one: **the eval harness must exercise the production call path, or the eval measures nothing.**

---

## 4. Finding 3 — no golden set, no gate on model behavior

`worker/src/tools/extractEval.ts:51` accepts a `--ground-truth` file. No ground-truth corpus is checked into the repo, and CI (`.github/workflows/ci.yml`) runs lint, typecheck, `supabase test db`, unit tests, and build — nothing that measures extraction quality.

The consequence: `MODEL_FALLBACK_PROMPT_VERSION` (`modelFallback.ts:33`) is a hand-maintained string, the prompt is a hand-maintained array of instructions (`modelFallback.ts:36`), and a change to either — or to the model ID, which defaults to `gpt-5.4` at `config.ts:66` — ships with zero regression signal. Confidence thresholds (`0.78`, `0.8`, `0.9`, `0.24` at `modelFallback.ts:29-32`) are asserted constants with no recorded calibration data behind them.

`public.extraction_quality_summary` observes production outcomes after the fact, which is valuable and correctly built on the immutable `audit_events` ledger rather than mutable rows (`ARCHITECTURE.md:203`). But post-hoc production monitoring is not a substitute for a pre-merge gate: it tells you a prompt change hurt after customers absorbed it.

### How it should have been designed

A versioned fixture corpus in the repo — 30–50 real drawings spanning the failure modes the parser already names (spec strings as part numbers, signature blocks as finishes, single-letter revisions) — with per-field accuracy floors as a required check. Prompt version derived from a content hash of the prompt + schema, not typed by hand. Threshold constants accompanied by the calibration run that produced them.

Cost of the corpus is a few hours. It is the highest-leverage missing artifact in the repo.

---

## 5. Finding 4 — production LLM calls are unobservable and unbounded

`buildExtractionCompletionPayload` (`worker/src/extractionObservability.ts:9`) records `modelName`, `modelFallbackUsed`, warning counts, and review fields. It does not record **tokens, latency, cost, or prompt version** — all of which the eval path already captures, and all of which the debug-lab result type already carries (`debugLab.ts:66-69`).

So `extraction_quality_summary` can answer "is accuracy drifting" but not "did the new model double our spend" or "is p95 latency degrading." For a system whose unit economics are per-drawing, that is the wrong half of the picture.

Separately, the production call has **no timeout and no abort signal** (`modelFallback.ts:351`). The worker processes one task at a time in a serial loop; a single hung request stalls all queued work until the SDK's default retry budget expires. There is a stale-task reaper (`queue.ts:128`), but it is a 10-minute crash-recovery net, not a request deadline.

### How it should have been designed

One `callModel()` wrapper that every model invocation goes through, owning: an explicit deadline (`AbortSignal.timeout`), retry with jitter on 429/5xx, token and cost accounting from `response.usage`, and emission of a structured audit event. No call site should be able to reach a provider SDK directly — that is what made it possible for the production path to quietly lack everything the eval path has.

---

## 6. Finding 5 — model identity is a string in four places

Provider inference is implemented three times, differently:

- `inferProvider()` — `worker/src/tools/extractEvalProviders.ts:75`
- an unchecked cast of the same call — `worker/src/extraction/debugLab.ts:378`
- reimplemented inline in the browser — `src/components/quotes/ExtractionLabCard.tsx:332`

A fourth site rewrites the model ID itself, prefixing `openai/` when an unqualified name is used against OpenRouter (`modelFallback.ts:257`). Fallback model lists are hardcoded string arrays (`debugLab.ts:96-98`).

Model identity, provider routing, capability flags (vision, structured outputs), and pricing should be **one typed registry** that both worker and UI import. Cost accounting then comes for free, capability checks stop being regex guesses on a model name, and the frontend cannot drift from the backend's routing rules.

---

## 7. Finding 6 — the worker is serial by construction

`worker/src/index.ts` claims one task, processes it to completion, sleeps `pollIntervalMs` (default 5s), repeats. Work fans out as parts × quantities × vendors.

Browser tasks genuinely need serialization per vendor profile — concurrent sessions against one authenticated portal profile risk lockout, which `persistentProfileLock.ts` and the OpenClaw gate's `concurrentSessionRisk` check correctly recognize. But **extraction tasks have no such constraint** and are stuck behind browser tasks anyway.

The right shape: typed task handlers with declared concurrency per task type — extraction parallel to a bounded pool, vendor automation serialized per `(vendor, profile)` — over the same atomic `api_claim_next_task` lease that already exists.

---

## 8. Finding 7 — one module is a stub wearing an agent's clothes

`worker/src/repair/suggestLocatorUpdate.ts` is registered as a real task type and dispatched from the main loop (`index.ts:1237`). It is a pure function returning three hardcoded English strings with invented confidence values (`0.8`, `0.55`, `0.35`) based on two `if` statements. It cannot see the page.

This matters beyond the module: the failure payloads it would consume already carry a full DOM snapshot and a screenshot (`portalWorkflow.ts:389`, `xometry.ts:152`) — exactly the input a vision model needs to propose a corrected locator. The scaffolding for a real self-repair loop is built and unused, while a placeholder occupies the slot and reports fabricated confidence into the same observability surfaces as measured values.

Either wire it to the artifacts it already has, or delete it. A stub that emits confidence numbers is worse than no stub, because downstream dashboards cannot tell the difference.

---

## 9. Finding 8 — aspiration and as-built share the same documents

`ARCHITECTURE.md:11-13` describes "invisible specialist agents," an "internal blackboard for agent negotiation," a "quoting swarm," and CAD plugins. None of this exists in the code. It sits in the same document, in the same voice, as the accurate and useful sections on the extraction boundary and the request lifecycle.

Around it: `PLAN.md`, `TODOS.md` (54KB), `PRD.md`, `ROADMAP.md`, `capabilitymap.md`, `horizon1–6.md`, `TODO-022-plan.md`, plus ~30 files under `docs/`.

This is not a cosmetic complaint. **Mixed aspirational and as-built documentation is what let two extraction implementations coexist for months without anyone noticing the eval measured the wrong one.** When the architecture doc describes a system nobody can diff against the code, it stops functioning as a check.

Separate them: `ARCHITECTURE.md` describes only what is deployed and must be verifiable against the tree; roadmap material moves to a clearly-marked forward-looking document. The horizon files should be consolidated or archived.

---

## 10. Smaller items

- **`markTaskCompleted(payloadPatch)` replaces, it does not patch** (`queue.ts:38`). Every one of the seven call sites compensates with `...task.payload`. Correct today, enforced only by discipline. Merge server-side or rename the parameter.
- **13 test files assert against migration SQL text** rather than behavior against a live database (`src/features/quotes/*-migration.test.ts`). CI already runs `supabase db reset` and `supabase test db` — these assertions belong there, where they would survive a refactor of the SQL.
- **Confidence constants are duplicated across modules** — `MODEL_ACCEPT_CONFIDENCE = 0.8` is declared in both `modelFallback.ts:30` and `hybridExtraction.ts:28`, and inlined as a literal in `debugLab.ts:366`. One policy module.
- **`config.anthropicApiKey` is dead in production** — see §3. Either wire Anthropic into the production provider set or drop the key from `WorkerConfig` so the configuration stops implying a capability that isn't there.

---

## 11. What the design should have been

A small core, with the worker, the eval CLI, and the debug lab as thin callers:

```
extraction-core/
  schema.ts       # Zod schema + prompt; version = hash(prompt + schema)
  provider.ts     # ExtractionProvider interface; typed errors; usage accounting
  providers/      # openai | anthropic | openrouter — one file each
  policy.ts       # sufficiency, merge, thresholds — declared once
  value.ts        # Extracted<T>: value + confidence + source + evidence
  callModel.ts    # deadline, retry, token/cost accounting, audit emission
eval/
  corpus/         # versioned fixtures + ground truth, checked in
  run.ts          # exercises the production path; CI gate on per-field floors
```

with two rules that would have prevented most of this review:

1. **Anything the system does not compute deterministically is an `Extracted<T>`** — model output and scraped DOM alike — and one policy function decides what each confidence/source combination is permitted to do. A price sourced from unanchored page text is not permitted to be a price.
2. **The eval harness calls the production path.** If measuring requires a second implementation, the abstraction is in the wrong place.

Everything else — the provider registry, cost accounting, per-type concurrency, the self-repair loop — follows from those two and is comparatively mechanical.

---

## 12. Sequenced path from here

No rewrite is required or recommended. Each step is independently shippable and independently valuable.

1. **Gate unanchored prices.** Make `priceSource: "body_text"` route to `manual_review_pending` with a locator-drift alert. Smallest diff, largest correctness gain. Product sign-off needed on the coverage tradeoff. (§2)
2. **Check in an eval corpus and add the CI floor.** 30–50 drawings with ground truth; per-field accuracy thresholds as a required check. Unblocks every later change to prompt, model, or thresholds. (§4)
3. **Collapse the two model paths.** Move the provider interface from `tools/` into the extraction core; make production and eval call it. Pin `temperature: 0` in production. Wire Anthropic as real failover. (§3)
4. **Introduce `callModel()`.** Deadline, retry, token/cost/latency accounting, audit emission. Extend `buildExtractionCompletionPayload` to carry usage and prompt version. (§5)
5. **Extract `Extracted<T>` and the policy module.** Migrate the adapters onto it; delete the duplicated thresholds. (§2, §10)
6. **Per-task-type concurrency in the worker.** Extraction parallel, vendor automation serialized per profile. (§7)
7. **Split as-built from aspirational docs.** Make `ARCHITECTURE.md` diffable against the tree. (§9)

---

## 13. What is already right

Stated plainly, because the recommendation throughout is *apply your own best pattern uniformly*, not *start over*:

- Deterministic-first extraction with model fallback only on weak or contested fields — the correct architecture for this problem, and the expensive part is done.
- Evidence, provenance, and per-field confidence persisted in `drawing_extractions`; normalized quote-facing values kept separate in `approved_part_requirements`. The raw/normalized boundary (`ARCHITECTURE.md:197-207`) is a genuinely hard call, made correctly.
- Fail-closed on parser/model disagreement rather than silent resolution.
- Quality rollups derived from immutable `audit_events` rather than mutable per-part rows — the right ledger choice, and one most teams get wrong.
- Client-safe sanitization of failure reasons; raw worker exceptions confined to internal records.
- `api.ts` correctly reduced to a deprecation shim over focused `api/*` modules — evidence the team already refactors toward narrower boundaries when the seam is visible.
- Atomic task claiming via `api_claim_next_task`, plus a stale-task reaper for crash recovery.
- Typed vendor failure codes with retry classification (`vendorTaskRetry.ts`) and the OpenClaw gate's synthetic-result detection — real rigor about not trusting automation output.
- Live-mode guards and simulate-in-production warnings.
