import type { ProviderUploadCapabilityDecision, ProviderUploadCapabilityObserved } from "./providerUploadCapabilityTypes.js";
import type { ValueSource } from "./extractedValue.js";
import type { ProviderDispatchAuthorization } from "./providerDispatchTypes.js";

/** Per-extraction model spend, recorded so cost and latency stay attributable. */
export type ModelUsageSummary = {
  provider: string;
  modelName: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  estimatedCostUsd: number | null;
  /** Coverage of cost estimates, never a claim of invoice reconciliation. */
  costCoverage?: "complete" | "partial" | "unknown";
  /** Known estimated subtotal; may exclude unresolved attempts. */
  knownCostSubtotalUsd?: number | null;
  attempts: number;
};

export type QueueTaskType =
  | "extract_part"
  | "debug_extract_part"
  | "generate_cad_preview"
  | "run_vendor_quote"
  | "poll_vendor_quote"
  | "publish_package"
  | "repair_adapter_candidate"
  // OVD-723 scan only export marking rescan (expand draft adds the enum value).
  | "export_marking_rescan";

export type QueueTaskStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type VendorName =
  | "xometry"
  | "fictiv"
  | "protolabs"
  | "sendcutsend"
  | "oshcut"
  | "fabworks"
  | "ponoko"
  | "quickparts"
  | "rapiddirect"
  | "geomiq"
  | "weerg"
  | "protolabsnetwork"
  | "partsbadger"
  | "fastdms"
  | "devzmanufacturing"
  | "infraredlaboratories"
  | "emachineshop"
  | "rmfg";

export const LIVE_AUTOMATION_VENDORS = [
  "xometry",
  "fictiv",
  "protolabs",
  "sendcutsend",
  "oshcut",
  "fabworks",
  "ponoko",
  "quickparts",
  "rapiddirect",
  "geomiq",
  "weerg",
  "protolabsnetwork",
  // OVD-678: RMFG API adapter, default off (not in the WORKER_LIVE_ADAPTERS
  // default, envelope unreviewed, admission policy disabled).
  "rmfg",
] as const;

export type LiveAutomationVendorName = (typeof LIVE_AUTOMATION_VENDORS)[number];
export type VendorStatus =
  | "queued"
  | "running"
  | "instant_quote_received"
  | "official_quote_received"
  | "manual_review_pending"
  | "manual_vendor_followup"
  | "failed"
  | "stale";

export type QueueTaskRecord = {
  id: string;
  organization_id: string;
  job_id: string | null;
  part_id: string | null;
  quote_run_id: string | null;
  package_id: string | null;
  task_type: QueueTaskType;
  status: QueueTaskStatus;
  payload: Record<string, unknown>;
  attempts: number;
  available_at: string;
  locked_at: string | null;
  locked_by: string | null;
  last_error: string | null;
};

export type PartRecord = {
  id: string;
  job_id: string;
  organization_id: string;
  name: string;
  normalized_key: string;
  cad_file_id: string | null;
  drawing_file_id: string | null;
  quantity: number;
};

export type JobFileRecord = {
  id: string;
  job_id: string;
  storage_bucket: string;
  storage_path: string;
  original_name: string;
  content_sha256?: string | null;
  trusted_content_sha256?: string | null;
  mime_type?: string | null;
  size_bytes?: number | null;
  file_kind: "cad" | "drawing" | "artifact" | "other";
};

export type ApprovedRequirementRecord = {
  id: string;
  part_id: string;
  description: string | null;
  part_number: string | null;
  revision: string | null;
  material: string;
  finish: string | null;
  tightest_tolerance_inch: number | null;
  quantity: number;
  quote_quantities: number[];
  requested_by_date: string | null;
  applicable_vendors: VendorName[];
  updated_at?: string;
  spec_snapshot?: unknown;
};

export const SUPPORTED_REVIEW_FIELDS = [
  "description",
  "partNumber",
  "revision",
  "material",
  "finish",
] as const;

export type SupportedReviewField = (typeof SUPPORTED_REVIEW_FIELDS)[number];

export const DRAWING_FIELD_NAMES = [...SUPPORTED_REVIEW_FIELDS, "process"] as const;

export type DrawingFieldName = (typeof DRAWING_FIELD_NAMES)[number];

export type RawExtractionField = {
  value: string | null;
  confidence: number;
  reviewNeeded: boolean;
  reasons: string[];
  sourceRegion: {
    page: number;
    line: number;
    columnStart: number;
    columnEnd: number;
    label: string | null;
  } | null;
};

export type DrawingExtractionPayload = {
  partId: string;
  description: string | null;
  partNumber: string | null;
  revision: string | null;
  modelFallbackUsed?: boolean;
  modelName?: string | null;
  modelPromptVersion?: string | null;
  /**
   * Tokens, latency, and cost for the model work behind this extraction.
   * Null when no model was consulted.
   */
  modelUsage?: ModelUsageSummary | null;
  fieldSelections?: Partial<
    Record<DrawingFieldName, "parser" | "model" | "review">
  >;
  extractedDescriptionRaw: RawExtractionField;
  extractedPartNumberRaw: RawExtractionField;
  extractedRevisionRaw: RawExtractionField;
  extractedFinishRaw: RawExtractionField;
  quoteDescription: string | null;
  quoteFinish: string | null;
  reviewFields: SupportedReviewField[];
  material: {
    raw: string | null;
    normalized: string | null;
    confidence: number;
    reviewNeeded: boolean;
    reasons: string[];
  };
  finish: {
    raw: string | null;
    normalized: string | null;
    confidence: number;
    reviewNeeded: boolean;
    reasons: string[];
  };
  generalTolerance: { raw: string | null; confidence: number };
  tightestTolerance: {
    reviewNeeded?: boolean;
    reasons?: string[];
    raw: string | null;
    valueInch: number | null;
    confidence: number;
    /** OVD-976: unit applied to the tightest value; "unknown" means valueInch is null on purpose. */
    unit?: "in" | "mm" | "um" | "mil" | "unknown";
    drawingUnits?: "inch" | "metric" | "mixed" | "unspecified";
  };
  notes: string[];
  threads: string[];
  evidence: Array<{
    field: string;
    page: number;
    snippet: string;
    confidence: number;
    reasons?: string[];
  }>;
  warnings: string[];
  debugCandidates?: Partial<
    Record<
      DrawingFieldName,
    Array<{
      value: string;
      page: number;
      line: number;
      columnStart: number;
      columnEnd: number;
      label: string | null;
      score: number;
      reasons: string[];
      snippet: string;
    }>
    >
  >;
  modelCandidates?: Partial<
    Record<
      DrawingFieldName,
    {
      value: string | null;
      confidence: number;
      fieldSource: "title_block" | "note" | "unknown";
      selected: boolean;
      reasons: string[];
      attempt: "title_block_crop" | "full_page";
    }
    >
  >;
  status: "needs_review" | "approved";
};

export type XometryDispatchAuthorization = {
  permitId: string;
  provider: "xometry";
  scopeFingerprint: string;
  envelopeRevision: "xometry-controlled-beta-envelope.v1";
  nonExportControlled: true;
};

export type VendorAutomationExecutionContext =
  | "production_dispatch"
  | "live_evaluation";

export type LiveEvaluationAuthorization = {
  nonExportControlled: true;
  cadFileSha256: string;
  drawingFileSha256: string | null;
};

export type ProviderPortalApprovalDescriptor = {
  schemaVersion: "provider-portal-approval.v1";
  providerKey: VendorName;
  accountMode: string;
  allowedOrigins: string[];
  intendedAction: "quote_only";
  artifactScope: Array<"cad_upload" | "drawing_upload" | "scrubbed_local_evidence">;
  cadPath: string;
  drawingPath: string | null;
  requestedQuantities: number[];
  cadFileSha256: string;
  drawingFileSha256: string | null;
};

export type LiveEvaluationUploadFile = {
  name: string;
  mimeType: string;
  buffer: Buffer;
};

export type LiveEvaluationUploadFiles = {
  cad: LiveEvaluationUploadFile;
  drawing: LiveEvaluationUploadFile | null;
};

export type VendorQuoteAdapterInput = {
  organizationId: string;
  quoteRunId: string;
  part: PartRecord;
  cadFile: JobFileRecord | null;
  drawingFile: JobFileRecord | null;
  stagedCadFile: StagedFile | null;
  stagedDrawingFile: StagedFile | null;
  requirement: ApprovedRequirementRecord;
  requestedQuantity: number;
  /**
   * Explicitly distinguishes standalone live evaluation from the production
   * queue path. Only the dedicated evaluation adapter entry point honors this
   * context as an authorization bypass.
   */
  executionContext?: VendorAutomationExecutionContext;
  /** Operator confirmation bound to the exact files selected for evaluation. */
  liveEvaluationAuthorization?: LiveEvaluationAuthorization;
  /** Exact operator-approved provider/action/origin/file tuple for portal evaluation. */
  providerPortalApproval?: ProviderPortalApprovalDescriptor;
  /** Canonical command scope rechecked against the operator-approved tuple. */
  providerPortalExecutionScope?: {
    cadPath: string;
    drawingPath: string | null;
    requestedQuantities: number[];
  };
  /** Required for production Xometry launches; omitted by explicit live evaluation. */
  xometryDispatchAuthorization?: XometryDispatchAuthorization;
  /** Required for production generic-provider launches (OVD-381/673); never set by live evaluation. */
  providerDispatchAuthorization?: ProviderDispatchAuthorization;
  /**
   * OVD-723: set by withExportControlDispatchRecheck. Adapters await it right
   * before the first file upload (after navigation and page classification);
   * it throws when the export-control gate no longer allows the dispatch.
   */
  beforeProviderDisclosure?: () => Promise<void>;
  /**
   * OVD-414: re-resolves the shared upload capability decision from a bounded
   * observation of the approved upload surface. The Xometry adapter awaits it
   * immediately before file selection and selects nothing unless the decision
   * is a passing classification covering every staged extension. A throw is a
   * denial.
   */
  uploadCapabilityCheckpoint?: (
    observation: ProviderUploadCapabilityObserved,
  ) => Promise<ProviderUploadCapabilityDecision>;
  /**
   * OVD-722 kill-switch checkpoint bound by the production dispatch path.
   * Adapters call it before each provider-facing navigation or mutation; it
   * rejects (fail-closed) when the switch is engaged or unreadable.
   */
  providerKillSwitchCheckpoint?: (
    checkpoint: "before_navigation" | "before_upload" | "before_configure" | "before_save",
  ) => Promise<void>;
  /**
   * OVD-748: aborted when the dispatch permit expires or the session lease is
   * lost. Adapters stop at their next checkpoint by throwing ProviderAbortedError.
   */
  signal?: AbortSignal;
  /**
   * OVD-779: operator-local capture hook injected only by the live-evaluation
   * harness when LIVE_HARNESS_SCREENSHOTS=1. Production never sets it, and
   * adapters honor it only on the live-evaluation path; adapters have no
   * screenshot code of their own (OVD-611).
   */
  harnessPriceCaptureHook?: HarnessPriceCaptureHook;
};

/** OVD-779: the only page surface a harness capture hook receives. */
export type HarnessPriceCapturePage = {
  screenshot(options: { path: string; fullPage?: boolean; type?: "png" }): Promise<unknown>;
};

export type HarnessPriceCaptureHook = (capture: {
  page: HarnessPriceCapturePage;
  label: "price-capture";
}) => Promise<VendorArtifact[]>;

export type StagedFile = {
  originalName: string;
  localPath: string;
  storageBucket: string;
  storagePath: string;
  /** Digest computed from the bytes downloaded by this worker. */
  trustedContentSha256?: string;
};

export type VendorArtifact = {
  kind: "screenshot" | "html_snapshot" | "trace" | "json";
  label: string;
  localPath: string;
  contentType: string;
};

export type GeographicOrigin = "domestic" | "foreign" | "unknown";

export type VendorQuoteAdapterOffer = {
  /** Stable provider-derived identifier for this purchasable option. */
  providerOptionId: string;
  providerLabel: string;
  quoteRef: string | null;
  quoteUrl: string | null;
  /** Exact quantity represented by this option when the adapter exposes it. */
  quantity?: number;
  unitPriceUsd: number;
  totalPriceUsd: number;
  leadTimeBusinessDays: number | null;
  shipReceiveBy: string | null;
  tier: string | null;
  sourcing: string | null;
  geographicOrigin: GeographicOrigin;
  sortRank: number;
  provenance: {
    containerSelector: string;
    providerOptionIdSource: "attribute" | "provider_label";
    priceSource: "selector";
    leadTimeSource: ValueSource;
    geographicOriginSource: "provider_text" | "none";
  };
  rawPayload: Record<string, unknown>;
};

export type VendorQuoteAdapterOutput = {
  vendor: VendorName;
  status: VendorStatus;
  unitPriceUsd: number | null;
  totalPriceUsd: number | null;
  leadTimeBusinessDays: number | null;
  quoteUrl: string | null;
  /** Vendor-stated quote timestamp, when the adapter can establish it. */
  quotedAt?: string | null;
  /** Explicit vendor expiration. Never inferred from collection freshness. */
  validUntil?: string | null;
  /** Explicit vendor duration, normalized to whole days. */
  validityDurationDays?: number | null;
  validitySource?: "vendor_date" | "vendor_duration" | null;
  /** Original vendor wording retained for operator review. */
  validityTerms?: string | null;
  /** Complete purchasable option set when the provider exposes variants. */
  offers?: VendorQuoteAdapterOffer[];
  dfmIssues: string[];
  /**
   * Worker automation status for operators (capture status, manual-review routing,
   * re-anchoring, simulation). Never provider-written; persisted only in
   * `raw_payload.workerNotes` of the offer row, never in the customer-visible `notes`.
   */
  notes: string[];
  /**
   * Text copied verbatim from the provider's own page or quote. The only source of the
   * customer-visible offer `notes` (shown as "Provider notes"). Leave unset unless the
   * adapter really captured provider-written text; no adapter does today.
   */
  providerNotes?: string[];
  artifacts: VendorArtifact[];
  rawPayload: Record<string, unknown>;
};

export type XometryDetectedFlow =
  | "simulate"
  | "quote_home"
  | "upload_complete"
  | "configuration_complete"
  | "instant_quote"
  | "manual_review"
  | "locator_drift"
  | "manual_vendor_followup";

export type XometryDrawingUploadMode =
  | "bundled"
  | "fallback"
  | "not_provided"
  | "not_needed";

/** @deprecated Alias of the shared {@link ValueSource} contract in `extractedValue.ts`. */
export type XometryValueSource = ValueSource;

// Stable raw-payload contract for Xometry results and failures.
export type XometryQuoteRawPayload = Record<string, unknown> & {
  automationVersion: string;
  executionContext?: VendorAutomationExecutionContext;
  detectedFlow: XometryDetectedFlow;
  uploadSelector?: string | null;
  drawingUploadMode?: XometryDrawingUploadMode | null;
  // Search term matched in the live Xometry control or exact quote-summary
  // field; saved values are independently confirmed before
  // `requirementsVerified` becomes true.
  selectedMaterial?: string | null;
  selectedFinish?: string | null;
  selectedTolerance?: string | null;
  toleranceSelector?: string | null;
  requirementsVerified?: boolean;
  saveConfigurationSelector?: string | null;
  priceSource?: ValueSource | null;
  leadTimeSource?: ValueSource | null;
  offers?: VendorQuoteAdapterOffer[];
  bodyExcerpt?: string;
  artifactStoragePaths?: string[];
  requestedQuantity?: number;
  retryCount?: number;
  failureCode?: string | null;
  url?: string | null;
};

export type VendorAutomationErrorCode =
  | "login_required"
  | "captcha"
  | "selector_failure"
  | "upload_failure"
  | "navigation_failure"
  | "unexpected_ui_state"
  | "anti_detection_block"
  | "profile_in_use"
  | "persistence_failure"
  | "not_implemented";

export class VendorAutomationError extends Error {
  constructor(
    message: string,
    public readonly code: VendorAutomationErrorCode,
    public readonly payload: Record<string, unknown> = {},
    public readonly artifacts: VendorArtifact[] = [],
  ) {
    super(message);
    this.name = "VendorAutomationError";
  }
}

export type WorkerConfig = {
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  workerMode: "simulate" | "live";
  workerLiveAdapters: LiveAutomationVendorName[];
  vendorStorageStateDir: string | null;
  vendorStorageStatePaths: Partial<Record<LiveAutomationVendorName, string>>;
  vendorStorageStateJson: Partial<Record<LiveAutomationVendorName, string>>;
  workerName: string;
  pollIntervalMs: number;
  quantityPricingLadder: number[];
  vendorRateLimitMs: number;
  pricingModelEnabled: boolean;
  pricingModelMinConfidence: number;
  httpHost: string;
  httpPort: number;
  workerTempDir: string;
  artifactBucket: string;
  playwrightHeadless: boolean;
  playwrightCaptureTrace: boolean;
  browserTimeoutMs: number;
  playwrightDisableSandbox: boolean;
  playwrightDisableDevShmUsage: boolean;
  xometryStorageStatePath: string | null;
  xometryStorageStateJson: string | null;
  xometryUserDataDir: string | null;
  xometryProfileSnapshotBucket: string | null;
  xometryProfileSnapshotObject: string | null;
  xometryProfileSnapshotGeneration: string | null;
  xometryProfileSnapshotMaxBytes: number;
  xometryBrowserChannel: string | null;
  /** Experimental printed-card witness; off until a real provider capture is qualified. */
  xometryPricedCardReadbackEnabled?: boolean;
  xometryBrowserEngine: "patchright" | "playwright" | "camoufox";
  xometryProfileLockWaitMs: number;
  xometrySessionFreshnessWarnDays: number;
  fictivStorageStatePath: string | null;
  fictivStorageStateJson: string | null;
  openAiApiKey: string | null;
  anthropicApiKey: string | null;
  openRouterApiKey: string | null;
  workerBuildVersion: string;
  /**
   * OVD-464: OVD-462 session lease around the generic provider route. Default
   * off until the lease migration is applied; off keeps today's behavior.
   */
  providerSessionLease?: "off" | "on";
  /** OVD-381: HMAC key for opaque lease identities; required when the lease is on. Never logged. */
  providerSessionNamespaceKey?: Uint8Array | null;
  /**
   * OVD-829: "on" reserves every live dispatch through the durable counter
   * (api_worker_reserve_provider_dispatch). Default off until the ovd-828-s1
   * migration is applied; off keeps the kill switch and counts the cap in
   * process (see ProviderDispatchCapMode).
   */
  providerDurableDispatchCap?: "off" | "on";
  titleBlockApprovalEnabled: boolean;
  drawingExtractionModel: string;
  drawingExtractionEnableModelFallback: boolean;
  drawingExtractionDebugAllowedModels: string[];
};
