export type QueueTaskType =
  | "extract_part"
  | "debug_extract_part"
  | "run_vendor_quote"
  | "poll_vendor_quote"
  | "publish_package"
  | "repair_adapter_candidate";

export type QueueTaskStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type VendorName =
  | "xometry"
  | "fictiv"
  | "protolabs"
  | "sendcutsend"
  | "partsbadger"
  | "fastdms"
  | "devzmanufacturing"
  | "infraredlaboratories";

export const LIVE_AUTOMATION_VENDORS = [
  "xometry",
  "fictiv",
  "protolabs",
  "sendcutsend",
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
  tightestTolerance: { raw: string | null; valueInch: number | null; confidence: number };
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
};

export type StagedFile = {
  originalName: string;
  localPath: string;
  storageBucket: string;
  storagePath: string;
};

export type VendorArtifact = {
  kind: "screenshot" | "html_snapshot" | "trace" | "json";
  label: string;
  localPath: string;
  contentType: string;
};

export type VendorQuoteAdapterOutput = {
  vendor: VendorName;
  status: VendorStatus;
  unitPriceUsd: number | null;
  totalPriceUsd: number | null;
  leadTimeBusinessDays: number | null;
  quoteUrl: string | null;
  dfmIssues: string[];
  notes: string[];
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
  | "manual_vendor_followup";

export type XometryDrawingUploadMode =
  | "bundled"
  | "fallback"
  | "not_provided"
  | "not_needed";

export type XometryValueSource = "selector" | "body_text" | "none";

// Stable raw-payload contract for Xometry results and failures.
export type XometryQuoteRawPayload = Record<string, unknown> & {
  automationVersion: string;
  detectedFlow: XometryDetectedFlow;
  uploadSelector?: string | null;
  drawingUploadMode?: XometryDrawingUploadMode | null;
  selectedMaterial?: string | null;
  selectedFinish?: string | null;
  priceSource?: XometryValueSource | null;
  leadTimeSource?: XometryValueSource | null;
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
  workerName: string;
  pollIntervalMs: number;
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
  fictivStorageStatePath?: string | null;
  openAiApiKey: string | null;
  anthropicApiKey: string | null;
  openRouterApiKey: string | null;
  workerBuildVersion: string;
  drawingExtractionModel: string;
  drawingExtractionEnableModelFallback: boolean;
  drawingExtractionDebugAllowedModels: string[];
};
