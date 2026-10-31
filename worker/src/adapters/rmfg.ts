import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { getAuthorizedLiveEvaluationFiles } from "../liveEvaluationFiles.js";
import {
  VendorAutomationError,
  type VendorAutomationErrorCode,
  type VendorQuoteAdapterInput,
  type VendorQuoteAdapterOutput,
  type WorkerConfig,
} from "../types.js";
import { VendorAdapter } from "./base.js";
import { providerDispatchAuthorizationDenial } from "./providerDispatchAuthorization.js";
import { RMFG_DISPATCH_ENVELOPE } from "./rmfgDispatchAuthorization.js";
import { createRmfgHttpTransport, type RmfgBlockReason } from "./rmfgHttpTransport.js";
import {
  runRmfgQuoteOnly,
  type RmfgQuoteInput,
  type RmfgQuoteRequest,
  type RmfgQuoteResult,
  type RmfgQuoteTransport,
  type RmfgStockRequirement,
} from "./rmfgQuoteTransport.js";

/**
 * RMFG live quote adapter (Weerg substitute for 1.0). Default off, quote only.
 *
 * It runs only when every gate holds: live worker mode, `rmfg` listed in
 * WORKER_LIVE_ADAPTERS, a current provider dispatch authorization for the RMFG
 * envelope bound to the staged bytes and quantity, an eligible process, and an
 * API key mounted at RMFG_API_KEY. The RMFG envelope is not in
 * REVIEWED_PROVIDER_DISPATCH_ENVELOPES and its admission policy is disabled, so
 * no permit can name it today; declaring it here admits nothing.
 *
 * The operator live evaluation harness (OVD-1057) replaces the dispatch
 * authorization with its own digest bound file capture and non export
 * controlled confirmation; an input that did not come through that entry point
 * has no captured bytes and is refused.
 *
 * The client can send only analyze, catalog and quote requests (see
 * rmfgHttpTransport.ts), so no cart, checkout or order endpoint is reachable.
 * Before each request the adapter awaits the OVD-722 kill switch checkpoint
 * and, before the upload, the OVD-723 export control recheck. Either refusal is
 * rethrown unchanged with no further request. A login, block, rate limit or
 * challenge response latches for the process and is never retried.
 */
export const RMFG_ADAPTER_REVISION = "rmfg-live-adapter.v1" as const;
/** Environment variable the worker mounts the RMFG API key into. The name only; the value is never logged. */
export const RMFG_API_KEY_ENV = "RMFG_API_KEY" as const;

export type RmfgEligibilityReason =
  | "process_evidence_missing"
  | "cnc_only_not_supported"
  | "process_outside_envelope"
  | "step_file_required";

/**
 * Seams added by OVD-722 (kill switch) and OVD-723 (export control recheck).
 * They match the fields those PRs add to VendorQuoteAdapterInput, so the
 * dispatch path that sets them reaches this adapter without a change here.
 */
export type RmfgDispatchSeams = {
  providerKillSwitchCheckpoint?: (
    checkpoint: "before_navigation" | "before_upload" | "before_configure" | "before_save",
  ) => Promise<void>;
  beforeProviderDisclosure?: () => Promise<void>;
};

/** Transport factory; the default is the pinned RMFG HTTP client. */
export type RmfgTransportFactory = (apiKey: string) => RmfgQuoteTransport & {
  blockedReason?: () => RmfgBlockReason | null;
};

export type RmfgAdapterOptions = {
  env?: NodeJS.ProcessEnv;
  createTransport?: RmfgTransportFactory;
  /** Pause before each design or quote status poll; tests set 0. */
  pollIntervalMs?: number;
};

/**
 * Analysis and quoting are asynchronous. Each of the design and the quote may
 * poll this many times, three seconds apart. With every step bounded at ten
 * seconds a phase stops as pending within about nine minutes at worst, and a
 * whole run within about nineteen.
 */
const POLL_INTERVAL_MS = 3_000;
const MAX_POLLS = 40;

type StopClassification = {
  code: Extract<VendorAutomationErrorCode, "login_required" | "captcha" | "anti_detection_block" | "unexpected_ui_state">;
  reason: "rmfg_authorization_required" | "rmfg_challenge_response" | "rmfg_blocked" | "rmfg_rate_limited"
    | "rmfg_account_action_required";
};

/** Finite terminal state each stop reports to the provider adapter contract. */
const STOP_TERMINAL_STATE: Record<StopClassification["reason"], string> = {
  rmfg_authorization_required: "login_required",
  rmfg_challenge_response: "captcha",
  rmfg_blocked: "unavailable",
  rmfg_rate_limited: "unavailable",
  rmfg_account_action_required: "manual_review",
};

/** An error naming a payment, plan, credit or terms step is never answered here. */
const ACCOUNT_ACTION_PATTERN = /terms|agreement|consent|payment|billing|credit|subscription|plan_required|upgrade/i;

/**
 * A challenge page (a non JSON answer from a JSON API) or a payment, plan or
 * terms demand latches for the process, like the HTTP client's 401, 402, 403
 * and 429 latch, so a new adapter instance cannot retry around it.
 */
let processChallengeLatch: StopClassification | null = null;

/** Test hook: clears the adapter's process wide challenge latch. */
export function resetRmfgAdapterStateForTests(): void {
  processChallengeLatch = null;
}

const CNC_PATTERN = /\b(?:cnc|mill(?:ing|ed)?|turn(?:ing|ed)?|lathe|machin(?:e|ed|ing)|swiss)\b/i;
const RMFG_PROCESS_PATTERNS = [
  /\b(?:sheet|laser|tube|brake)\b/i,
  /\b(?:bend(?:ing)?|form(?:ing|ed)?)\b/i,
  /\b(?:weld(?:ing|ed|ment)?|fabricat(?:ion|ed))\b/i,
];
const NOT_CNC_NOTE = "RMFG builds sheet metal, tube laser, bending and welding parts, not CNC machined parts.";

function normalizedProcess(value: string): string {
  return value.trim().toLowerCase().replaceAll(/[_-]+/g, " ");
}

function specValue(specSnapshot: unknown, keys: readonly string[]): unknown {
  if (!specSnapshot || typeof specSnapshot !== "object" || Array.isArray(specSnapshot)) return undefined;
  const record = specSnapshot as Record<string, unknown>;
  for (const key of keys) if (record[key] !== undefined) return record[key];
  return undefined;
}

/**
 * Process eligibility. A part whose stated process is only CNC (milling,
 * turning, machining) is refused; RMFG has no CNC service. A process that names
 * both, such as "laser cut and machined", is left for RMFG's own DFM to judge.
 */
export function evaluateRmfgEligibility(input: {
  process: string | null;
  fileName: string | null;
}): { eligible: true } | { eligible: false; reason: RmfgEligibilityReason; note: string } {
  if (!input.process) {
    return { eligible: false, reason: "process_evidence_missing",
      note: "RMFG was not asked: the part has no stated process. " + NOT_CNC_NOTE };
  }
  const process = normalizedProcess(input.process);
  const rmfgProcess = RMFG_PROCESS_PATTERNS.some((pattern) => pattern.test(process));
  if (CNC_PATTERN.test(process) && !rmfgProcess) {
    return { eligible: false, reason: "cnc_only_not_supported", note: `RMFG was not asked: ${NOT_CNC_NOTE}` };
  }
  if (!rmfgProcess) {
    return { eligible: false, reason: "process_outside_envelope",
      note: `RMFG was not asked: the process "${input.process}" is outside its envelope. ${NOT_CNC_NOTE}` };
  }
  if (!input.fileName || !/\.(step|stp)$/i.test(input.fileName)) {
    return { eligible: false, reason: "step_file_required", note: "RMFG was not asked: it quotes from a STEP file." };
  }
  return { eligible: true };
}

function selectionsFrom(specSnapshot: unknown): RmfgQuoteInput["selections"] {
  const raw = specValue(specSnapshot, ["rmfgSelections", "rmfg_selections"]);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const selections: RmfgQuoteInput["selections"] = {};
  for (const [partId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const { materialId, tubeProfileId } = value as Record<string, unknown>;
    if ((materialId !== undefined && typeof materialId !== "string")
      || (tubeProfileId !== undefined && typeof tubeProfileId !== "string")) return {};
    selections[partId] = {
      ...(typeof materialId === "string" ? { materialId } : {}),
      ...(typeof tubeProfileId === "string" ? { tubeProfileId } : {}),
    };
  }
  return selections;
}

/** Operator-stated sheet stock, such as `{ grade: "6061-T6", thicknessIn: 0.125 }`. */
function stockFrom(specSnapshot: unknown): RmfgStockRequirement | undefined {
  const raw = specValue(specSnapshot, ["rmfgStock", "rmfg_stock"]);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const { grade, thicknessIn } = raw as Record<string, unknown>;
  return typeof grade === "string" && typeof thicknessIn === "number" ? { grade, thicknessIn } : undefined;
}

function checkpointFor(request: RmfgQuoteRequest): "before_navigation" | "before_upload" | "before_configure" {
  if (request.endpoint === "analyze") return "before_upload";
  if (request.endpoint === "quote") return "before_configure";
  return "before_navigation";
}

type StopOutcome = StopClassification | null;

function errorCodes(body: unknown): string {
  const error = body && typeof body === "object" ? (body as Record<string, unknown>).error : null;
  if (!error || typeof error !== "object") return "";
  const { code, type } = error as Record<string, unknown>;
  return [code, type].filter((value) => typeof value === "string").join(" ");
}

function classifyStop(status: number, body: unknown, blockedBefore: RmfgBlockReason | null): StopOutcome {
  const accountAction: StopClassification = { code: "unexpected_ui_state", reason: "rmfg_account_action_required" };
  // A latched client answers without a request; report the original block, not a challenge.
  if (blockedBefore === "authorization_required") return { code: "login_required", reason: "rmfg_authorization_required" };
  if (blockedBefore === "rate_limited") return { code: "anti_detection_block", reason: "rmfg_rate_limited" };
  if (blockedBefore === "account_action_required") return accountAction;
  if (status === 402 || (status >= 400 && ACCOUNT_ACTION_PATTERN.test(errorCodes(body)))) return accountAction;
  if (status === 401) return { code: "login_required", reason: "rmfg_authorization_required" };
  if (status === 429) return { code: "anti_detection_block", reason: "rmfg_rate_limited" };
  // RMFG answers JSON; an HTML or empty answer is a challenge or interstitial page.
  if (status !== 0 && status !== 204 && body === null) return { code: "captcha", reason: "rmfg_challenge_response" };
  if (status === 403) return { code: "anti_detection_block", reason: "rmfg_blocked" };
  return null;
}

function stopError(stop: StopClassification, extra: Record<string, unknown> = {}): VendorAutomationError {
  return new VendorAutomationError(
    "RMFG refused the request; it needs manual follow up and is not retried.",
    stop.code,
    { vendor: "rmfg", reason: stop.reason, adapterRevision: RMFG_ADAPTER_REVISION, retryable: false,
      terminalState: STOP_TERMINAL_STATE[stop.reason], quoteOnly: true, orderProhibited: true, ...extra },
  );
}

function refusal(reason: string, message: string, extra: Record<string, unknown> = {}): VendorAutomationError {
  return new VendorAutomationError(message, "unexpected_ui_state", {
    vendor: "rmfg", reason, adapterRevision: RMFG_ADAPTER_REVISION, providerInteractionAttempted: false,
    providerMutationPossible: false, retryable: false, terminalState: "unavailable", quoteOnly: true,
    orderProhibited: true, ...extra,
  });
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function authorizeRmfgRequest(input: VendorQuoteAdapterInput, evaluation: boolean,
  stock: RmfgStockRequirement | undefined): void {
  if (evaluation) {
    if (!getAuthorizedLiveEvaluationFiles(input) || input.liveEvaluationAuthorization?.nonExportControlled !== true) {
      throw refusal("evaluation_file_authorization_missing",
        "RMFG evaluation needs the harness's digest bound file capture and non export controlled confirmation.");
    }
    // The approved evaluation is one part, quantity 1, on a stated stock; nothing else reaches RMFG.
    if (input.requestedQuantity !== 1 || !stock
      || specValue(input.requirement.spec_snapshot, ["rmfgSelections", "rmfg_selections"]) !== undefined) {
      throw refusal("evaluation_scope_unapproved",
        "RMFG evaluation quotes only quantity 1 on a stated stock; nothing was sent.", { terminalState: "unsupported" });
    }
  } else {
    const denial = providerDispatchAuthorizationDenial(input, { provider: "rmfg", ...RMFG_DISPATCH_ENVELOPE });
    if (denial) throw refusal(denial, "RMFG dispatch is not authorized for these exact files and quantity.");
    if (input.providerDispatchAuthorization?.envelope.affirmations?.nonExportControlled !== true) {
      throw refusal("export_control_affirmation_missing",
        "RMFG dispatch needs a non export controlled affirmation; nothing was sent.");
    }
  }
}

export class RmfgAdapter extends VendorAdapter {
  private readonly env: NodeJS.ProcessEnv;
  private readonly createTransport: RmfgTransportFactory;
  private readonly pollIntervalMs: number;

  constructor(config: WorkerConfig, options: RmfgAdapterOptions = {}) {
    super("rmfg", config);
    this.env = options.env ?? process.env;
    this.createTransport = options.createTransport
      ?? ((apiKey) => createRmfgHttpTransport({ apiKey }));
    this.pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  }

  async quote(baseInput: VendorQuoteAdapterInput): Promise<VendorQuoteAdapterOutput> {
    const input = baseInput as VendorQuoteAdapterInput & RmfgDispatchSeams;
    const statedProcess = specValue(input.requirement?.spec_snapshot, ["process"]);
    const eligibility = evaluateRmfgEligibility({
      process: typeof statedProcess === "string" && statedProcess.trim() ? statedProcess : null,
      fileName: input.stagedCadFile?.originalName ?? input.cadFile?.original_name ?? null,
    });
    if (!eligibility.eligible) return this.finite(input, eligibility.reason, eligibility.note, "unsupported");

    if (this.config.workerMode !== "live" || !this.config.workerLiveAdapters.includes("rmfg")) {
      return this.finite(input, "rmfg_live_adapter_disabled",
        "RMFG live quoting is off for this worker; no request was sent.", "unavailable");
    }
    const evaluation = input.executionContext === "live_evaluation";
    // A stated stock is the operator evaluation's own scope; production quotes use person-chosen catalog IDs.
    const stock = evaluation ? stockFrom(input.requirement.spec_snapshot) : undefined;
    authorizeRmfgRequest(input, evaluation, stock);

    // OVD-722: fresh read before any provider facing step; a refusal propagates unchanged.
    await input.providerKillSwitchCheckpoint?.("before_navigation");
    if (processChallengeLatch) throw stopError(processChallengeLatch, { providerInteractionAttempted: false });

    const staged = input.stagedCadFile!;
    const captured = evaluation ? getAuthorizedLiveEvaluationFiles(input)!.cad : null;
    const bytes = new Uint8Array(captured ? captured.buffer : await readFile(staged.localPath));
    const expectedSha256 = evaluation ? input.liveEvaluationAuthorization!.cadFileSha256 : staged.trustedContentSha256;
    if (sha256(bytes) !== expectedSha256) {
      throw refusal("dispatch_authorization_file_mismatch", "The staged RMFG file no longer matches its authorization.");
    }
    const transport = this.transportFromMountedKey();

    let seamError: { error: unknown } | null = null;
    let stop: StopOutcome = null;
    // Set once the run has its result: a request still waiting on its checkpoint never starts afterwards.
    let closed = false;
    const guarded: RmfgQuoteTransport = async (request) => {
      if (seamError || stop || closed) return { status: 0, body: null };
      try {
        await input.providerKillSwitchCheckpoint?.(checkpointFor(request));
        // OVD-723: the export control gate is asked again right before the file leaves.
        if (request.endpoint === "analyze") await input.beforeProviderDisclosure?.();
      } catch (error) {
        seamError = { error };
        return { status: 0, body: null };
      }
      if (closed) return { status: 0, body: null };
      const blockedBefore = transport.blockedReason?.() ?? null;
      const response = await transport(request);
      stop = classifyStop(response.status, response.body, blockedBefore);
      if (stop?.code === "captcha" || stop?.reason === "rmfg_account_action_required") processChallengeLatch = stop;
      return stop ? { status: 0, body: null } : response;
    };

    const keyBase = sha256([input.quoteRunId, input.part.id, expectedSha256, input.requestedQuantity].join(":"));
    const result = await runRmfgQuoteOnly({
      file: { name: captured?.name ?? staged.originalName, bytes },
      quantity: input.requestedQuantity,
      selections: stock ? {} : selectionsFrom(input.requirement.spec_snapshot),
      ...(stock ? { stock } : {}),
      analyzeKey: `ovd-${keyBase.slice(0, 40)}-analyze`,
      quoteKey: `ovd-${keyBase.slice(0, 40)}-quote`,
      pollIntervalMs: this.pollIntervalMs,
      maxPolls: MAX_POLLS,
    }, guarded).finally(() => { closed = true; });

    // Narrowing is lost across the closure, so read the captured values through a cast.
    const capturedSeam = seamError as { error: unknown } | null;
    if (capturedSeam) throw capturedSeam.error;
    const capturedStop = stop as StopOutcome;
    if (capturedStop) throw stopError(capturedStop, { providerInteractionAttempted: true });
    return this.fromResult(input, result);
  }

  private transportFromMountedKey(): ReturnType<RmfgTransportFactory> {
    const apiKey = this.env[RMFG_API_KEY_ENV];
    if (!apiKey) {
      throw refusal("rmfg_api_key_missing", `RMFG needs an API key mounted at ${RMFG_API_KEY_ENV}; nothing was sent.`);
    }
    try {
      return this.createTransport(apiKey);
    } catch {
      // The client rejects a malformed key; its message is not carried, so nothing about the key leaves here.
      throw refusal("rmfg_api_key_malformed", `The key mounted at ${RMFG_API_KEY_ENV} is malformed; nothing was sent.`);
    }
  }

  private fromResult(input: VendorQuoteAdapterInput, result: RmfgQuoteResult): VendorQuoteAdapterOutput {
    const offerEvidence = result.offer;
    // Labels and figures only, no RMFG IDs: what a reviewer or the publish path needs to check the price.
    const rmfgEvidence = {
      stock: result.stock ? { label: result.stock.label, displayThickness: result.stock.displayThickness,
        thicknessIn: result.stock.thicknessIn } : null,
      stockOffered: result.stockMatches?.map(({ label, thicknessIn }) => ({ label, thicknessIn })) ?? null,
      dfmStatus: result.dfmStatus, dfmIssueCodes: result.dfmIssueCodes, requirementCodes: result.requirementCodes,
      totalCents: offerEvidence?.totalCents ?? null,
      // RMFG quotes never select shipping or compute tax, and its minimum order is checked only at cart payment.
      excludes: offerEvidence ? ["shipping", "tax", "cart_minimum_order"] : null,
      fulfillment: offerEvidence?.fulfillment ?? null, pricedComponents: offerEvidence?.pricedComponents ?? null,
    };
    const rawPayload = {
      source: "rmfg-api", adapterRevision: RMFG_ADAPTER_REVISION, transportRevision: result.revision, rmfgEvidence,
      rmfgState: result.state, reason: result.reason, designId: result.designId, quoteId: result.quoteId,
      requirementCodes: result.requirementCodes, dfmStatus: result.dfmStatus, dfmIssueCodes: result.dfmIssueCodes,
      stock: result.stock, stockMatches: result.stockMatches ?? null, requestedQuantity: input.requestedQuantity,
      quoteOnly: true, orderProhibited: true,
    };
    if (result.state === "ready" && result.offer) {
      const offer = result.offer;
      return {
        vendor: "rmfg", status: "instant_quote_received",
        unitPriceUsd: offer.unitPriceUsd, totalPriceUsd: offer.totalPriceUsd,
        leadTimeBusinessDays: null, quoteUrl: null,
        offers: [{
          providerOptionId: offer.providerOptionId, providerLabel: "RMFG standard",
          quoteRef: offer.quoteRef, quoteUrl: null, quantity: offer.quantity,
          unitPriceUsd: offer.unitPriceUsd, totalPriceUsd: offer.totalPriceUsd,
          leadTimeBusinessDays: null, shipReceiveBy: null, tier: null, sourcing: null,
          geographicOrigin: "unknown", sortRank: 0,
          provenance: { containerSelector: "api:quote.items[0]", providerOptionIdSource: "provider_label",
            priceSource: "selector", leadTimeSource: "none", geographicOriginSource: "none" },
          rawPayload: { provenance: offer.provenance },
        }],
        dfmIssues: result.dfmIssueCodes, notes: [], artifacts: [], rawPayload,
        validUntil: offer.validUntil, validitySource: offer.validUntil ? "vendor_date" : null,
      };
    }
    if (result.state === "error" || result.state === "unknown") {
      // An unrecognized answer needs a person to read it; an error answer has no quote to read.
      throw new VendorAutomationError(
        `RMFG did not return a usable quote (${result.reason}).`,
        "unexpected_ui_state",
        { ...rawPayload, vendor: "rmfg", retryable: false,
          // An input the transport refused never reached RMFG.
          providerInteractionAttempted: result.reason !== "invalid_quote_input",
          providerMutationPossible: result.reason !== "invalid_quote_input",
          terminalState: result.state === "unknown" ? "manual_review" : "unavailable" },
      );
    }
    type FollowUpState = Exclude<RmfgQuoteResult["state"], "ready" | "error" | "unknown">;
    const followUp: Record<FollowUpState, { note: string; terminalState: string }> = {
      pending: { note: "RMFG is still pricing this part; follow up in RMFG.", terminalState: "unavailable" },
      requires_input: { terminalState: "configuration_required",
        note: "RMFG needs a person to choose stock or answer a requirement before it can price this part." },
      blocked: { note: "RMFG reported a manufacturing issue that blocks this quote.", terminalState: "unsupported" },
    };
    const outcome = followUp[result.state as FollowUpState];
    return {
      vendor: "rmfg", status: "manual_vendor_followup", unitPriceUsd: null, totalPriceUsd: null,
      leadTimeBusinessDays: null, quoteUrl: null, dfmIssues: result.dfmIssueCodes,
      notes: [outcome.note], artifacts: [], rawPayload: { ...rawPayload, terminalState: outcome.terminalState },
    };
  }

  private finite(input: VendorQuoteAdapterInput, reason: string, note: string,
    terminalState: "unsupported" | "unavailable"): VendorQuoteAdapterOutput {
    return {
      vendor: "rmfg", status: "manual_vendor_followup", unitPriceUsd: null, totalPriceUsd: null,
      leadTimeBusinessDays: null, quoteUrl: null, dfmIssues: [], notes: [note], artifacts: [],
      rawPayload: { source: "rmfg-api", adapterRevision: RMFG_ADAPTER_REVISION, reason, terminalState,
        requestedQuantity: input.requestedQuantity, providerInteractionAttempted: false,
        quoteOnly: true, orderProhibited: true },
    };
  }
}
