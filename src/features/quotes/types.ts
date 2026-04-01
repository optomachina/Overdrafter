import type { User } from "@supabase/supabase-js";
import type { ArchivedDeleteReporting } from "@/features/quotes/archive-delete-errors";
import type { RequestedServiceIntent } from "@/features/quotes/service-intent";
import type {
  AppRole,
  ClientOptionKind,
  Database,
  ExtractionStatus,
  JobFileKind,
  Json,
  ProjectInviteStatus,
  ProjectRole as SupabaseProjectRole,
  QuoteRequestStatus,
  QueueTaskStatus,
  QueueTaskType,
  VendorName,
  VendorStatus,
} from "@/integrations/supabase/types";

export type ProjectRole = SupabaseProjectRole;

export type OrganizationRecord = Database["public"]["Tables"]["organizations"]["Row"];
export type MembershipRecord = Database["public"]["Tables"]["organization_memberships"]["Row"];
export type ProjectRecord = Database["public"]["Tables"]["projects"]["Row"];
export type ProjectMembershipRecord = Database["public"]["Tables"]["project_memberships"]["Row"];
export type ProjectJobRecord = Database["public"]["Tables"]["project_jobs"]["Row"];
export type ProjectInviteRecord = Database["public"]["Tables"]["project_invites"]["Row"];
export type UserPinnedProjectRecord = Database["public"]["Tables"]["user_pinned_projects"]["Row"];
export type UserPinnedJobRecord = Database["public"]["Tables"]["user_pinned_jobs"]["Row"];
export type PricingPolicyRecord = Database["public"]["Tables"]["pricing_policies"]["Row"];
export type JobRecord = Database["public"]["Tables"]["jobs"]["Row"];
export type JobFileRecord = Database["public"]["Tables"]["job_files"]["Row"];
export type PartRecord = Database["public"]["Tables"]["parts"]["Row"];
export type DrawingExtractionRecord = Database["public"]["Tables"]["drawing_extractions"]["Row"];
export type DrawingPreviewAssetRecord = Database["public"]["Tables"]["drawing_preview_assets"]["Row"];
export type DebugExtractionRunRecord = Database["public"]["Tables"]["debug_extraction_runs"]["Row"];
export type ApprovedPartRequirementRecord = Database["public"]["Tables"]["approved_part_requirements"]["Row"];
export type QuoteRequestRecord = Database["public"]["Tables"]["quote_requests"]["Row"];
export type ServiceRequestLineItemRecord = Database["public"]["Tables"]["service_request_line_items"]["Row"];
export type QuoteRunRecord = Database["public"]["Tables"]["quote_runs"]["Row"];
export type VendorQuoteResultRecord = Database["public"]["Tables"]["vendor_quote_results"]["Row"];
export type VendorQuoteOfferRecord = Database["public"]["Tables"]["vendor_quote_offers"]["Row"];
export type VendorQuoteArtifactRecord = Database["public"]["Tables"]["vendor_quote_artifacts"]["Row"];
export type PublishedQuotePackageRecord = Database["public"]["Tables"]["published_quote_packages"]["Row"];
export type PublishedQuoteOptionRecord = Database["public"]["Tables"]["published_quote_options"]["Row"];
export type ClientSelectionRecord = Database["public"]["Tables"]["client_selections"]["Row"];
export type AuditEventRecord = Database["public"]["Tables"]["audit_events"]["Row"];
export type WorkQueueRecord = Database["public"]["Tables"]["work_queue"]["Row"];

export type ClientActivityEvent = {
  id: string;
  jobId: string;
  packageId: string | null;
  eventType: string;
  payload: Json;
  occurredAt: string;
};

export type ProjectAssigneeProfile = {
  userId: string;
  email: string | null;
  givenName: string | null;
  familyName: string | null;
  fullName: string | null;
};

export type EvidenceItem = {
  field: string;
  page: number;
  snippet: string;
  confidence: number;
  reasons?: string[];
};

export type ExtractedFieldData = {
  raw: string | null;
  confidence: number;
  reviewNeeded: boolean;
  reasons: string[];
};

export type RequirementFieldName = "description" | "partNumber" | "revision" | "finish";
export type RequirementFieldOwnership = "auto" | "user";
export type RequirementFieldDisplaySource =
  | "client"
  | "approved_user"
  | "approved_auto"
  | "extraction";
export type RequirementFieldResolution = {
  value: string | null;
  source: RequirementFieldDisplaySource;
  approvedSource: RequirementFieldOwnership | null;
  staleAuto: boolean;
  extractionNewer: boolean;
  reviewBlocked: boolean;
  approvedValue: string | null;
  extractionValue: string | null;
};

export type DrawingExtractionData = {
  partId: string;
  description: string | null;
  partNumber: string | null;
  revision: string | null;
  workerBuildVersion?: string | null;
  extractorVersion?: string | null;
  quoteDescription?: string | null;
  quoteFinish?: string | null;
  model?: {
    fallbackUsed: boolean;
    name: string | null;
    promptVersion: string | null;
  };
  geometryProjection?: {
    schemaVersion: string;
    extractorVersion: string;
    generatedFrom: {
      drawingExtraction: boolean;
      approvedRequirement: boolean;
    };
    scene: {
      width: number;
      height: number;
      depth: number;
      primitives: Array<{
        id: string;
        kind: "box" | "cylinder" | "hole" | "cutout";
        position: { x: number; y: number; z: number };
        size: { x: number; y: number; z: number };
        metadata: {
          featureClass: "body" | "hole" | "pocket" | "wall";
          confidence: number;
        };
      }>;
    };
  } | null;
  fieldSelections?: Partial<
    Record<"description" | "partNumber" | "revision" | "material" | "finish" | "process", "parser" | "model" | "review">
  >;
  rawFields: {
    description: ExtractedFieldData;
    partNumber: ExtractedFieldData;
    revision: ExtractedFieldData;
    finish: ExtractedFieldData;
  };
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
  tightestTolerance: {
    raw: string | null;
    valueInch: number | null;
    confidence: number;
  };
  evidence: EvidenceItem[];
  warnings: string[];
  reviewFields?: string[];
  status: ExtractionStatus;
};

export type DebugExtractionRunSummary = {
  id: string;
  jobId: string;
  partId: string;
  requestedModel: string;
  effectiveModel: string | null;
  workerBuildVersion: string | null;
  extractorVersion: string | null;
  modelFallbackUsed: boolean | null;
  modelPromptVersion: string | null;
  status: QueueTaskStatus;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  result: Json;
};

export type ClientExtractionLifecycle =
  | "uploaded"
  | "queued"
  | "extracting"
  | "succeeded"
  | "partial"
  | "failed";

export type ClientExtractionDiagnostics = {
  lifecycle: ClientExtractionLifecycle;
  warningCount: number;
  warnings: string[];
  missingFields: string[];
  reviewFields?: string[];
  lastFailureCode: string | null;
  lastFailureMessage: string | null;
  extractedAt: string | null;
  failedAt: string | null;
  updatedAt: string | null;
  pageCount: number;
  hasCadFile: boolean;
  hasDrawingFile: boolean;
};

export type ClientPartRequirementView = {
  description: string | null;
  partNumber: string | null;
  revision: string | null;
  quoteDescription?: string | null;
  material: string;
  finish: string | null;
  quoteFinish?: string | null;
  tightestToleranceInch: number | null;
  process: string | null;
  notes: string | null;
  quantity: number;
  quoteQuantities: number[];
  requestedByDate: string | null;
};

export type ClientPartMetadataRecord = {
  partId: string;
  jobId: string;
  organizationId: string;
  requirement: ClientPartRequirementView;
  extraction: ClientExtractionDiagnostics;
};

export type RfqServiceScope = {
  requestedServiceKinds: string[];
  primaryServiceKind: string | null;
  serviceNotes: string | null;
};

export type RfqShippingPriority =
  | "standard"
  | "expedite_if_needed"
  | "expedite_required";

export type RfqSourcingRegionPreference =
  | "best_value"
  | "domestic_preferred"
  | "domestic_only"
  | "foreign_allowed";

export type RfqSupplierSelectionMode =
  | "open_market"
  | "preferred_suppliers"
  | "customer_nominated_suppliers";

export type RfqReleaseStatus =
  | "unknown"
  | "prototype"
  | "pre_release"
  | "released";

export type RfqReviewDisposition =
  | "draft"
  | "needs_review"
  | "approved_for_quote"
  | "hold";

export type RfqInspectionLevel = "standard" | "fai" | "custom";

export type RfqProjectShippingConstraints = {
  requestedByDate: string | null;
  shippingPriority: RfqShippingPriority | null;
  shipToRegion: string | null;
  constraintsNotes: string | null;
};

export type RfqProjectCertificationDefaults = {
  requiredCertifications: string[];
  traceabilityRequired: boolean | null;
  inspectionLevel: RfqInspectionLevel | null;
  notes: string | null;
};

export type RfqProjectSourcingPreferences = {
  regionPreference: RfqSourcingRegionPreference | null;
  supplierSelectionMode: RfqSupplierSelectionMode | null;
  allowSplitAward: boolean | null;
  notes: string | null;
};

export type RfqProjectReleaseContext = {
  releaseStatus: RfqReleaseStatus | null;
  reviewDisposition: RfqReviewDisposition | null;
  reviewOwner: string | null;
  notes: string | null;
};

export type RfqProjectMetadata = {
  serviceScope: RfqServiceScope;
  shipping: RfqProjectShippingConstraints;
  certifications: RfqProjectCertificationDefaults;
  sourcing: RfqProjectSourcingPreferences;
  release: RfqProjectReleaseContext;
};

export type RfqLineItemRequestFields = {
  description: string | null;
  partNumber: string | null;
  revision: string | null;
  material: string;
  finish: string | null;
  tightestToleranceInch: number | null;
  process?: string | null;
  notes?: string | null;
  quantity: number;
  requestedQuoteQuantities: number[];
  requestedByDate: string | null;
};

export type RfqLineItemShippingConstraints = {
  requestedByDateOverride: string | null;
  packagingNotes: string | null;
  shippingNotes: string | null;
};

export type RfqLineItemCertificationRequirements = {
  requiredCertifications: string[];
  materialCertificationRequired: boolean | null;
  certificateOfConformanceRequired: boolean | null;
  inspectionLevel: RfqInspectionLevel | null;
  notes: string | null;
};

export type RfqLineItemSourcingPreferences = {
  regionPreferenceOverride: RfqSourcingRegionPreference | null;
  preferredSuppliers: string[];
  materialProvisioning: "supplier_to_source" | "customer_supplied" | "tbd" | null;
  notes: string | null;
};

export type RfqLineItemReleaseContext = {
  releaseStatus: RfqReleaseStatus | null;
  reviewDisposition: RfqReviewDisposition | null;
  quoteBlockedUntilRelease: boolean | null;
  notes: string | null;
};

export type RfqLineItemMetadata = {
  request: RfqLineItemRequestFields;
  shipping: RfqLineItemShippingConstraints;
  certifications: RfqLineItemCertificationRequirements;
  sourcing: RfqLineItemSourcingPreferences;
  release: RfqLineItemReleaseContext;
};

export type RfqLineItemExtendedMetadata = Omit<RfqLineItemMetadata, "request">;

export const CLIENT_PART_REQUEST_MVP_FIELDS = [
  "requestedServiceKinds",
  "primaryServiceKind",
  "serviceNotes",
  "description",
  "partNumber",
  "revision",
  "material",
  "finish",
  "tightestToleranceInch",
  "process",
  "notes",
  "quantity",
  "requestedQuoteQuantities",
  "requestedByDate",
] as const satisfies ReadonlyArray<keyof ClientPartRequestEditableFields>;

export type ClientPartRequestEditableFields = RfqLineItemRequestFields & RequestedServiceIntent;

export type ApprovedPartRequirement = Omit<ClientPartRequestEditableFields, "requestedQuoteQuantities"> &
  RfqLineItemExtendedMetadata & {
    partId: string;
    quoteQuantities: number[];
    applicableVendors: VendorName[];
  };

export type VendorQuoteResult = {
  vendor: VendorName;
  status: VendorStatus;
  partId: string;
  requestedQuantity: number;
  unitPriceUsd: number | null;
  totalPriceUsd: number | null;
  leadTimeBusinessDays: number | null;
  quoteUrl: string | null;
  dfmIssues: string[];
  notes: string[];
  artifacts: string[];
};

export type PublishedQuoteOption = {
  optionKind: ClientOptionKind;
  label: string;
  requestedQuantity: number;
  publishedPriceUsd: number;
  leadTimeBusinessDays: number | null;
  comparisonSummary: string | null;
  sourceVendorQuoteId: string;
  sourceVendorQuoteOfferId: string | null;
  markupPolicyVersion: string;
};

export type ManualQuoteOfferInput = {
  laneLabel: string;
  requestedQuantity?: number | null;
  sourcing?: string | null;
  tier?: string | null;
  quoteRef?: string | null;
  quoteDateIso?: string | null;
  totalPriceUsd: number;
  unitPriceUsd?: number | null;
  leadTimeBusinessDays?: number | null;
  shipReceiveBy?: string | null;
  dueDate?: string | null;
  process?: string | null;
  material?: string | null;
  finish?: string | null;
  tightestTolerance?: string | null;
  toleranceSource?: string | null;
  threadCallouts?: string | null;
  threadMatchNotes?: string | null;
  notes?: string | null;
};

export type ManualQuoteArtifactInput = {
  artifactType?: string | null;
  storageBucket?: string | null;
  storagePath: string;
  metadata?: Json;
};

export type ManualQuoteRecordResult = {
  quoteRunId: string;
  vendorQuoteResultId: string;
  createdNewQuoteRun: boolean;
};

export type AppMembership = {
  id: string;
  role: AppRole;
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
};

export type OrganizationDetails = {
  id: string;
  name: string;
  companyName: string | null;
  logoUrl: string | null;
  phone: string | null;
  billingStreet: string | null;
  billingCity: string | null;
  billingState: string | null;
  billingZip: string | null;
  billingCountry: string;
  shippingSameAsBilling: boolean;
  shippingStreet: string | null;
  shippingCity: string | null;
  shippingState: string | null;
  shippingZip: string | null;
  shippingCountry: string;
};

export type AppSessionAuthState = "authenticated" | "anonymous" | "invalid_session" | "session_error";

export type ProjectAccessRole = ProjectRole;

export type AccessibleProjectSummary = {
  project: ProjectRecord;
  currentUserRole: ProjectAccessRole;
  memberCount: number;
  partCount: number;
  inviteCount: number;
};

export type ArchivedProjectSummary = {
  project: ProjectRecord;
  currentUserRole: ProjectAccessRole;
  partCount: number;
};

export type ClientDraftInput = {
  title: string;
  description?: string;
  projectId?: string | null;
  tags?: string[];
  requestedServiceKinds?: string[];
  primaryServiceKind?: string | null;
  serviceNotes?: string | null;
  requestedQuoteQuantities?: number[];
  requestedByDate?: string | null;
};

export type ProjectInviteSummary = {
  id: string;
  email: string;
  role: ProjectRole;
  status: ProjectInviteStatus;
  token: string;
  expiresAt: string;
  createdAt: string;
};

export type SidebarPins = {
  projectIds: string[];
  jobIds: string[];
};

export type OrganizationMembershipSummary = {
  id: string;
  userId: string;
  email: string;
  role: AppRole;
  createdAt: string;
};

export type JobPartSummary = {
  jobId: string;
  partNumber: string | null;
  revision: string | null;
  description: string | null;
  requestedServiceKinds: string[];
  primaryServiceKind: string | null;
  serviceNotes: string | null;
  quantity: number | null;
  requestedQuoteQuantities: number[];
  requestedByDate: string | null;
  importedBatch: string | null;
  selectedSupplier: string | null;
  selectedPriceUsd: number | null;
  selectedLeadTimeBusinessDays: number | null;
};

export type AppSessionData = {
  user: User | null;
  memberships: AppMembership[];
  isVerifiedAuth: boolean;
  isPlatformAdmin?: boolean;
  authState?: AppSessionAuthState;
  membershipError?: string;
};

export type PartAggregate = PartRecord & {
  cadFile: JobFileRecord | null;
  drawingFile: JobFileRecord | null;
  extraction: DrawingExtractionRecord | null;
  approvedRequirement: ApprovedPartRequirementRecord | null;
  clientRequirement?: ClientPartRequirementView | null;
  clientExtraction?: ClientExtractionDiagnostics | null;
  vendorQuotes: VendorQuoteAggregate[];
};

export type DrawingPreviewImage = {
  pageNumber: number;
  storageBucket: string;
  storagePath: string;
  width: number | null;
  height: number | null;
};

export type DrawingPreviewData = {
  pageCount: number;
  thumbnail: DrawingPreviewImage | null;
  pages: DrawingPreviewImage[];
};

export type VendorQuoteAggregate = VendorQuoteResultRecord & {
  offers: VendorQuoteOfferRecord[];
  artifacts: VendorQuoteArtifactRecord[];
};

export type QuotePlotExclusionReason =
  | "missing_unit_price"
  | "missing_total_price"
  | "invalid_unit_price_format"
  | "invalid_total_price_format"
  | "invalid_lead_time_format"
  | "missing_persisted_offer_id";

export type QuotePlotExclusionRecord = {
  vendorQuoteResultId: string;
  vendorKey: VendorName;
  offerId: string | null;
  offerKey: string | null;
  supplier: string | null;
  laneLabel: string | null;
  reasons: QuotePlotExclusionReason[];
};

export type QuotePlotReasonCount = {
  reason: QuotePlotExclusionReason;
  count: number;
};

export type QuoteDiagnostics = {
  rawQuoteRowCount: number;
  rawOfferCount: number;
  plottableOfferCount: number;
  excludedOfferCount: number;
  excludedOffers: QuotePlotExclusionRecord[];
  excludedReasonCounts: QuotePlotReasonCount[];
};

export type QuoteDataStatus = "available" | "schema_unavailable" | "invalid_for_plotting";

export type QuoteRunAggregate = QuoteRunRecord & {
  vendorQuotes: VendorQuoteAggregate[];
};

export type PublishedPackageAggregate = PublishedQuotePackageRecord & {
  options: PublishedQuoteOptionRecord[];
  selections: ClientSelectionRecord[];
};

export type JobAggregate = {
  job: JobRecord;
  files: JobFileRecord[];
  parts: PartAggregate[];
  quoteRuns: QuoteRunAggregate[];
  packages: PublishedPackageAggregate[];
  pricingPolicy: PricingPolicyRecord | null;
  workQueue: WorkQueueRecord[];
  drawingPreviewAssets?: DrawingPreviewAssetRecord[];
  debugExtractionRuns?: DebugExtractionRunRecord[];
};

export type WorkerReadinessSnapshot = {
  reachable: boolean;
  ready: boolean | null;
  workerName: string | null;
  workerBuildVersion?: string | null;
  workerMode: string | null;
  drawingExtractionModel?: string | null;
  drawingExtractionDebugAllowedModels?: string[];
  drawingExtractionModelFallbackEnabled?: boolean;
  status: string | null;
  readinessIssues: string[];
  message: string | null;
  url: string | null;
};

export type ExtractionModelProvider = "openai" | "anthropic" | "openrouter";

export type DiscoveredExtractionModel = {
  provider: ExtractionModelProvider;
  modelId: string;
  displayLabel: string;
  sourceFreshness: "refreshed" | "fallback";
  previewRunnable: boolean;
  debugRunnable: boolean;
  defaultHint: boolean;
  stale: boolean;
};

export type DiscoveredModelCatalog = {
  models: DiscoveredExtractionModel[];
  updatedAt: string | null;
  catalogFreshness: "cached" | "refreshed";
  refreshing: boolean;
  stale: boolean;
  error: string | null;
};

export type PreviewExtractionResult = {
  partId: string;
  jobId: string;
  provider: ExtractionModelProvider;
  requestedModel: string;
  effectiveModel: string;
  workerBuildVersion: string;
  extractorVersion: string;
  modelFallbackUsed: boolean;
  modelPromptVersion: string | null;
  parserContext: string;
  durationMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  estimatedCostUsd: number | null;
  extraction: Record<string, unknown>;
  status: "approved" | "needs_review";
  warnings: string[];
  evidence: Array<Record<string, unknown>>;
  summary: {
    missingFields: string[];
    reviewFields: string[];
    lifecycle: "partial" | "succeeded";
  };
  preview: {
    pageCount: number;
    previewAssetCount: number;
    hasPreviewImage: boolean;
  };
  modelAttempts: Array<{
    attempt: "title_block_crop" | "full_page";
    titleBlockSufficient: boolean;
    rawResponse: unknown;
  }>;
};

export type ClientQuoteRequestStatus =
  | "not_requested"
  | QuoteRequestStatus;

export type QuoteRequestSubmissionResult = {
  jobId: string;
  accepted: boolean;
  created: boolean;
  deduplicated: boolean;
  quoteRequestId: string | null;
  quoteRunId: string | null;
  serviceRequestLineItemId: string | null;
  status: ClientQuoteRequestStatus;
  // The backend may return business-rule blockers such as retry gating,
  // client request throttling, or org-level cost circuit-breaker denials.
  reasonCode: string | null;
  reason: string | null;
  // Phase 2 semantics: this is the actual vendor set requested or blocked for the job.
  requestedVendors: VendorName[];
};

export type QuoteRequestCancellationResult = {
  jobId: string | null;
  accepted: boolean;
  canceled: boolean;
  quoteRequestId: string | null;
  quoteRunId: string | null;
  status: ClientQuoteRequestStatus;
  reasonCode: string | null;
  reason: string | null;
};

export type PartDetailAggregate = {
  job: JobRecord;
  files: JobFileRecord[];
  summary: JobPartSummary | null;
  packages: PublishedQuotePackageRecord[];
  part: PartAggregate | null;
  quoteDataStatus: QuoteDataStatus;
  quoteDataMessage: string | null;
  quoteDiagnostics: QuoteDiagnostics;
  projectIds: string[];
  drawingPreview: DrawingPreviewData;
  latestQuoteRequest: QuoteRequestRecord | null;
  allServiceLineItems: ServiceRequestLineItemRecord[] | null;
  latestServiceLineItem: ServiceRequestLineItemRecord | null;
  latestQuoteRun: QuoteRunRecord | null;
  revisionSiblings: Array<{
    jobId: string;
    revision: string | null;
    title: string;
  }>;
};

export type ClientPartRequestUpdateInput = {
  jobId: string;
} & ClientPartRequestEditableFields &
  RfqLineItemExtendedMetadata;

export type ClientQuoteWorkspaceItem = {
  job: JobRecord;
  files: JobFileRecord[];
  summary: JobPartSummary | null;
  part: PartAggregate | null;
  quoteDataStatus: QuoteDataStatus;
  quoteDataMessage: string | null;
  quoteDiagnostics: QuoteDiagnostics;
  projectIds: string[];
  drawingPreview: DrawingPreviewData;
  latestQuoteRequest: QuoteRequestRecord | null;
  allServiceLineItems: ServiceRequestLineItemRecord[] | null;
  latestServiceLineItem: ServiceRequestLineItemRecord | null;
  latestQuoteRun: QuoteRunRecord | null;
};

export type ServiceAwareProjectSummary = {
  serviceTypes: string[];
  distinctServiceCount: number;
  allQuoteCompatible: boolean;
  requestedByDate: string | null;
  requestedQuoteQuantities: number[];
  lineItemCount: number;
};

export type ArchivedJobSummary = {
  job: JobRecord;
  summary: JobPartSummary | null;
  projectNames: string[];
};

export type ArchivedJobDeleteFailure = {
  jobId: string;
  message: string;
  reporting?: ArchivedDeleteReporting;
};

export type ArchivedJobDeleteResult = {
  deletedJobIds: string[];
  failures: ArchivedJobDeleteFailure[];
};

export type PrepareJobFileUploadResult =
  | {
      status: "duplicate_in_job";
    }
  | {
      status: "reused";
      fileId: string;
    }
  | {
      status: "upload_required";
      storageBucket: string;
      storagePath: string;
    };

export type UploadFilesToJobSummary = {
  uploadedCount: number;
  reusedCount: number;
  duplicateNames: string[];
};

export type ClientPackageAggregate = {
  package: PublishedQuotePackageRecord;
  job: JobRecord;
  options: PublishedQuoteOptionRecord[];
  selections: ClientSelectionRecord[];
};

export type QuoteRunReadiness = {
  ready: boolean;
  successfulVendorQuotes: number;
  failedVendorQuotes: number;
  blockingVendorStates: number;
  unapprovedExtractions: number;
  repairTasks: number;
  priorRequirementsMatch: boolean;
  reasons: string[];
};

export type QueueTaskDescriptor = {
  taskType: QueueTaskType;
  status: QueueTaskStatus;
  label: string;
};

export type ExtractionFieldConfidence = {
  value: string | number | null;
  confidence: number;
};

export type ExtractionJson = Json;
export type JobSummaryMetrics = {
  totalJobs: number;
  needsReview: number;
  published: number;
  quoted: number;
};

export type UploadableFile = File & {
  previewKind?: JobFileKind;
};

export type VendorCapabilityTag =
  | "cnc_milling"
  | "cnc_turning"
  | "sheet_metal"
  | "injection_molding"
  | "3d_printing"
  | "laser_cutting"
  | "waterjet"
  | "edm"
  | "urethane_casting"
  | "metal_3d_printing"
  | "finishing_anodize"
  | "finishing_powder_coat"
  | "finishing_bead_blast"
  | "finishing_plating"
  | "finishing_passivation"
  | "material_aluminum"
  | "material_steel"
  | "material_stainless"
  | "material_plastic_abs"
  | "material_plastic_delrin"
  | "material_plastic_peek"
  | "material_plastic_nylon"
  | "material_brass"
  | "material_copper"
  | "material_titanium"
  | "tight_tolerance"
  | "high_volume"
  | "rapid_prototyping"
  | "production_run";

export type VendorCapabilityProfile = {
  id: string;
  vendor: VendorName;
  displayName: string;
  supportedProcesses: string[];
  supportedMaterials: string[];
  supportedFinishes: string[];
  capabilityTags: VendorCapabilityTag[];
  minToleranceInch: number | null;
  minQuantity: number;
  maxQuantity: number | null;
  typicalLeadMinDays: number | null;
  typicalLeadMaxDays: number | null;
  supportsInstantQuote: boolean;
  activeForQuotes: boolean;
  notes: string | null;
};
