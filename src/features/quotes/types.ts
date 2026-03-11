import type { User } from "@supabase/supabase-js";
import type {
  AppRole,
  ClientOptionKind,
  Database,
  ExtractionStatus,
  JobFileKind,
  JobStatus,
  Json,
  ProjectInviteStatus,
  ProjectRole,
  QuoteRunStatus,
  QueueTaskStatus,
  QueueTaskType,
  VendorName,
  VendorStatus,
} from "@/integrations/supabase/types";

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
export type ApprovedPartRequirementRecord = Database["public"]["Tables"]["approved_part_requirements"]["Row"];
export type QuoteRunRecord = Database["public"]["Tables"]["quote_runs"]["Row"];
export type VendorQuoteResultRecord = Database["public"]["Tables"]["vendor_quote_results"]["Row"];
export type VendorQuoteOfferRecord = Database["public"]["Tables"]["vendor_quote_offers"]["Row"];
export type VendorQuoteArtifactRecord = Database["public"]["Tables"]["vendor_quote_artifacts"]["Row"];
export type PublishedQuotePackageRecord = Database["public"]["Tables"]["published_quote_packages"]["Row"];
export type PublishedQuoteOptionRecord = Database["public"]["Tables"]["published_quote_options"]["Row"];
export type ClientSelectionRecord = Database["public"]["Tables"]["client_selections"]["Row"];
export type AuditEventRecord = Database["public"]["Tables"]["audit_events"]["Row"];
export type WorkQueueRecord = Database["public"]["Tables"]["work_queue"]["Row"];

export type EvidenceItem = {
  field: string;
  page: number;
  snippet: string;
  confidence: number;
};

export type DrawingExtractionData = {
  partId: string;
  description: string | null;
  partNumber: string | null;
  revision: string | null;
  material: {
    raw: string | null;
    normalized: string | null;
    confidence: number;
  };
  finish: {
    raw: string | null;
    normalized: string | null;
    confidence: number;
  };
  tightestTolerance: {
    raw: string | null;
    valueInch: number | null;
    confidence: number;
  };
  evidence: EvidenceItem[];
  warnings: string[];
  status: ExtractionStatus;
};

export type ApprovedPartRequirement = {
  partId: string;
  description: string | null;
  partNumber: string | null;
  revision: string | null;
  material: string;
  finish: string | null;
  tightestToleranceInch: number | null;
  process?: string | null;
  notes?: string | null;
  quantity: number;
  quoteQuantities: number[];
  requestedByDate: string | null;
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

export type AppSessionAuthState = "authenticated" | "anonymous" | "invalid_session";

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
  authState?: AppSessionAuthState;
};

export type PartAggregate = PartRecord & {
  cadFile: JobFileRecord | null;
  drawingFile: JobFileRecord | null;
  extraction: DrawingExtractionRecord | null;
  approvedRequirement: ApprovedPartRequirementRecord | null;
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
};

export type WorkerReadinessSnapshot = {
  reachable: boolean;
  ready: boolean | null;
  workerName: string | null;
  workerMode: string | null;
  status: string | null;
  readinessIssues: string[];
  message: string | null;
  url: string | null;
};

export type PartDetailAggregate = {
  job: JobRecord;
  files: JobFileRecord[];
  summary: JobPartSummary | null;
  packages: PublishedQuotePackageRecord[];
  part: PartAggregate | null;
  projectIds: string[];
  drawingPreview: DrawingPreviewData;
  latestQuoteRun: QuoteRunRecord | null;
  revisionSiblings: Array<{
    jobId: string;
    revision: string | null;
    title: string;
  }>;
};

export type ClientPartRequestUpdateInput = {
  jobId: string;
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

export type ClientQuoteWorkspaceItem = {
  job: JobRecord;
  files: JobFileRecord[];
  summary: JobPartSummary | null;
  part: PartAggregate | null;
  projectIds: string[];
  drawingPreview: DrawingPreviewData;
  latestQuoteRun: QuoteRunRecord | null;
};

export type ArchivedJobSummary = {
  job: JobRecord;
  summary: JobPartSummary | null;
  projectNames: string[];
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
