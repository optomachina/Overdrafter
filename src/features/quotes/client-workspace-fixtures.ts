import type { User } from "@supabase/supabase-js";
import type {
  AccessibleProjectSummary,
  AppMembership,
  AppSessionData,
  ArchivedJobDeleteResult,
  ArchivedJobSummary,
  ArchivedProjectSummary,
  ClientActivityEvent,
  ClientPartRequirementView,
  ProjectAssigneeProfile,
  ClientPartRequestUpdateInput,
  ClientQuoteWorkspaceItem,
  DrawingPreviewData,
  JobFileRecord,
  JobPartSummary,
  JobRecord,
  PartAggregate,
  PartDetailAggregate,
  ProjectInviteSummary,
  ProjectMembershipRecord,
  ProjectRecord,
  QuoteDiagnostics,
  QuoteRunRecord,
  PublishedQuotePackageRecord,
  VendorQuoteAggregate,
} from "@/features/quotes/types";
import type {
  AppRole,
  ProjectRole,
  VendorName,
} from "@/integrations/supabase/types";
import type { ProjectJobRecord } from "@/features/quotes/types";
import {
  normalizeRfqLineItemExtendedMetadata,
  sanitizeClientVisibleRfqLineItemExtendedMetadata,
} from "@/features/quotes/rfq-metadata";
import { normalizeRequestedServiceIntent } from "@/features/quotes/service-intent";
import {
  QUOTED_SAMPLE_ASSETS,
  QUOTED_SAMPLE_LANES,
  QUOTED_SAMPLE_PART,
  QUOTED_SAMPLE_RFQ,
  getQuotedSampleSelectedLane,
} from "@/features/quotes/demo/quoted-sample";
import { FIXTURE_STORAGE_BUCKET } from "@/lib/stored-file";

function buildFixtureQuoteDiagnostics(vendorQuotes: VendorQuoteAggregate[]): QuoteDiagnostics {
  const rawOfferCount = vendorQuotes.reduce((count, quote) => count + quote.offers.length, 0);

  return {
    rawQuoteRowCount: vendorQuotes.length,
    rawOfferCount,
    plottableOfferCount: rawOfferCount,
    excludedOfferCount: 0,
    excludedOffers: [],
    excludedReasonCounts: [],
  };
}

function ensureFixtureClientRequirement(part: PartAggregate | null | undefined): ClientPartRequirementView | null {
  if (!part) {
    return null;
  }

  if (part.clientRequirement) {
    return part.clientRequirement;
  }

  const approved = part.approvedRequirement;
  const snapshot =
    approved?.spec_snapshot && typeof approved.spec_snapshot === "object"
      ? (approved.spec_snapshot as Record<string, unknown>)
      : null;
  const request = {
    description: approved?.description ?? null,
    partNumber: approved?.part_number ?? null,
    revision: approved?.revision ?? null,
    quoteDescription: approved?.description ?? null,
    material: approved?.material ?? "",
    finish: approved?.finish ?? null,
    quoteFinish: approved?.finish ?? null,
    threads: typeof snapshot?.threads === "string" ? snapshot.threads : null,
    tightestToleranceInch: approved?.tightest_tolerance_inch ?? null,
    process: typeof snapshot?.process === "string" ? snapshot.process : null,
    notes: typeof snapshot?.notes === "string" ? snapshot.notes : null,
    quantity: approved?.quantity ?? part.quantity ?? 1,
    quoteQuantities: approved?.quote_quantities ?? [approved?.quantity ?? part.quantity ?? 1],
    requestedByDate: approved?.requested_by_date ?? null,
    projectPartProperties: null,
  } satisfies ClientPartRequirementView;

  part.clientRequirement = request;
  return request;
}

export const CLIENT_WORKSPACE_FIXTURE_SCENARIOS = [
  {
    id: "landing-anonymous",
    label: "Landing",
    description: "Anonymous landing screen with no session.",
    canonicalPath: "/?fixture=landing-anonymous",
  },
  {
    id: "client-empty",
    label: "Client Empty",
    description: "Signed-in client with an empty workspace.",
    canonicalPath: "/?fixture=client-empty",
  },
  {
    id: "client-needs-attention",
    label: "Needs Attention",
    description: "Single part waiting for request cleanup.",
    canonicalPath: "/parts/fx-job-needs-attention?fixture=client-needs-attention",
  },
  {
    id: "client-quoted",
    label: "Quoted Project",
    description: "Quoted client workspace with selectable vendor offers.",
    canonicalPath: "/projects/fx-project-quoted?fixture=client-quoted",
  },
  {
    id: "client-published",
    label: "Published Review",
    description: "Published review-ready project.",
    canonicalPath: "/projects/fx-project-published/review?fixture=client-published",
  },
] as const;

export type FixtureScenarioId = (typeof CLIENT_WORKSPACE_FIXTURE_SCENARIOS)[number]["id"];

export type ClientWorkspaceGateway = {
  getSessionData: () => AppSessionData;
  fetchAccessibleJobs: () => Promise<JobRecord[]>;
  fetchAccessibleProjects: () => Promise<AccessibleProjectSummary[]>;
  fetchArchivedJobs: () => Promise<ArchivedJobSummary[]>;
  fetchArchivedProjects: () => Promise<ArchivedProjectSummary[]>;
  fetchJobPartSummariesByJobIds: (jobIds: string[]) => Promise<JobPartSummary[]>;
  fetchProjectJobMembershipsByJobIds: (jobIds: string[]) => Promise<ProjectJobRecord[]>;
  fetchSidebarPins: () => Promise<{ projectIds: string[]; jobIds: string[] }>;
  pinProject: (projectId: string) => Promise<void>;
  unpinProject: (projectId: string) => Promise<void>;
  pinJob: (jobId: string) => Promise<void>;
  unpinJob: (jobId: string) => Promise<void>;
  fetchProject: (projectId: string) => Promise<ProjectRecord>;
  fetchProjectMemberships: (projectId: string) => Promise<ProjectMembershipRecord[]>;
  fetchProjectAssigneeProfiles: (projectId: string) => Promise<ProjectAssigneeProfile[]>;
  fetchProjectInvites: (projectId: string) => Promise<ProjectInviteSummary[]>;
  fetchJobsByProject: (projectId: string) => Promise<JobRecord[]>;
  fetchPartDetail: (jobId: string) => Promise<PartDetailAggregate>;
  fetchClientQuoteWorkspaceByJobIds: (jobIds: string[]) => Promise<ClientQuoteWorkspaceItem[]>;
  fetchClientActivityEventsByJobIds: (jobIds: string[], limitPerJob?: number) => Promise<ClientActivityEvent[]>;
  createProject: (input: { name: string; description?: string }) => Promise<string>;
  updateProject: (input: { projectId: string; name: string; description?: string }) => Promise<string>;
  archiveProject: (projectId: string) => Promise<string>;
  unarchiveProject: (projectId: string) => Promise<string>;
  dissolveProject: (projectId: string) => Promise<string>;
  inviteProjectMember: (input: { projectId: string; email: string; role?: ProjectRole }) => Promise<ProjectInviteSummary>;
  removeProjectMember: (projectMembershipId: string) => Promise<string>;
  assignJobToProject: (input: { jobId: string; projectId: string }) => Promise<string>;
  removeJobFromProject: (jobId: string, projectId: string) => Promise<string>;
  archiveJob: (jobId: string) => Promise<string>;
  unarchiveJob: (jobId: string) => Promise<string>;
  deleteArchivedJob: (jobId: string) => Promise<string>;
  deleteArchivedJobs: (jobIds: string[]) => Promise<ArchivedJobDeleteResult>;
  setJobSelectedVendorQuoteOffer: (jobId: string, offerId: string | null) => Promise<string>;
  updateClientPartRequest: (input: ClientPartRequestUpdateInput) => Promise<string>;
  resetClientPartPropertyOverrides?: (input: {
    jobId: string;
    fields: Array<"description" | "partNumber" | "material" | "finish" | "tightestToleranceInch" | "threads">;
  }) => Promise<string>;
};

type FixtureState = {
  session: AppSessionData;
  accessibleJobs: JobRecord[];
  accessibleProjects: AccessibleProjectSummary[];
  archivedJobs: ArchivedJobSummary[];
  archivedProjects: ArchivedProjectSummary[];
  partSummariesByJobId: Record<string, JobPartSummary>;
  projectJobMemberships: ProjectJobRecord[];
  partDetailsByJobId: Record<string, PartDetailAggregate>;
  workspaceByJobId: Record<string, ClientQuoteWorkspaceItem>;
  clientActivityByJobId: Record<string, ClientActivityEvent[]>;
  sidebarPins: {
    projectIds: string[];
    jobIds: string[];
  };
  projectMembershipsByProjectId: Record<string, ProjectMembershipRecord[]>;
  projectInvitesByProjectId: Record<string, ProjectInviteSummary[]>;
};

const FIXTURE_ORGANIZATION_ID = "fixture-org-1";
const FIXTURE_TIMESTAMP = "2026-03-10T17:00:00.000Z";
const FIXTURE_PASSWORD_LABEL = "Overdrafter123!";

const scenarioStateCache = new Map<FixtureScenarioId, FixtureState>();

function fixtureTimestampOffset(minutes: number): string {
  return new Date(Date.parse(FIXTURE_TIMESTAMP) + minutes * 60_000).toISOString();
}

function createClientActivityEvent(input: {
  id: string;
  jobId: string;
  eventType: string;
  minutesAfterStart: number;
  packageId?: string | null;
  payload?: ClientActivityEvent["payload"];
}): ClientActivityEvent {
  return {
    id: input.id,
    jobId: input.jobId,
    packageId: input.packageId ?? null,
    eventType: input.eventType,
    payload: input.payload ?? {},
    occurredAt: fixtureTimestampOffset(input.minutesAfterStart),
  };
}

function cloneValue<T>(value: T): T {
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }

  return JSON.parse(JSON.stringify(value)) as T;
}

function createFixtureUser(input: {
  id: string;
  email: string;
  role?: AppRole;
  name: string;
}): User {
  return {
    id: input.id,
    aud: "authenticated",
    role: "authenticated",
    email: input.email,
    email_confirmed_at: FIXTURE_TIMESTAMP,
    phone: "",
    confirmed_at: FIXTURE_TIMESTAMP,
    last_sign_in_at: FIXTURE_TIMESTAMP,
    app_metadata: {
      provider: "email",
      providers: ["email"],
      appRole: input.role ?? "client",
    },
    user_metadata: {
      full_name: input.name,
      fixturePassword: FIXTURE_PASSWORD_LABEL,
    },
    identities: [],
    created_at: FIXTURE_TIMESTAMP,
    updated_at: FIXTURE_TIMESTAMP,
    is_anonymous: false,
  } as User;
}

function createSession(input: {
  user: User | null;
  role?: AppRole;
  organizationId?: string;
  organizationName?: string;
  organizationSlug?: string;
}): AppSessionData {
  const memberships: AppMembership[] =
    input.user && input.role
      ? [
          {
            id: `membership-${input.role}`,
            role: input.role,
            organizationId: input.organizationId ?? FIXTURE_ORGANIZATION_ID,
            organizationName: input.organizationName ?? "Fixture Machine Co.",
            organizationSlug: input.organizationSlug ?? "fixture-machine-co",
          },
        ]
      : [];

  return {
    user: input.user,
    memberships,
    isVerifiedAuth: Boolean(input.user),
    authState: input.user ? "authenticated" : "anonymous",
  };
}

function createProjectRecord(input: {
  id: string;
  ownerUserId: string;
  name: string;
  description?: string | null;
  archivedAt?: string | null;
}): ProjectRecord {
  return {
    id: input.id,
    organization_id: FIXTURE_ORGANIZATION_ID,
    owner_user_id: input.ownerUserId,
    name: input.name,
    description: input.description ?? null,
    archived_at: input.archivedAt ?? null,
    created_at: FIXTURE_TIMESTAMP,
    updated_at: FIXTURE_TIMESTAMP,
  };
}

function createProjectSummary(
  project: ProjectRecord,
  currentUserRole: ProjectRole,
  partCount: number,
): AccessibleProjectSummary {
  return {
    project,
    currentUserRole,
    memberCount: 1,
    partCount,
    inviteCount: 0,
  };
}

function createJobRecord(input: {
  id: string;
  createdBy: string;
  title: string;
  description: string;
  status: JobRecord["status"];
  requestedServiceKinds?: string[];
  primaryServiceKind?: string | null;
  serviceNotes?: string | null;
  requestedQuoteQuantities?: number[];
  requestedByDate?: string | null;
  projectId?: string | null;
  selectedVendorQuoteOfferId?: string | null;
  tags?: string[];
}): JobRecord {
  const serviceIntent = normalizeRequestedServiceIntent({
    requestedServiceKinds: input.requestedServiceKinds ?? [],
    primaryServiceKind: input.primaryServiceKind ?? null,
    serviceNotes: input.serviceNotes ?? null,
  });

  return {
    id: input.id,
    organization_id: FIXTURE_ORGANIZATION_ID,
    project_id: input.projectId ?? null,
    selected_vendor_quote_offer_id: input.selectedVendorQuoteOfferId ?? null,
    created_by: input.createdBy,
    title: input.title,
    description: input.description,
    status: input.status,
    source: "fixture_mode",
    active_pricing_policy_id: "fixture-pricing-policy",
    tags: input.tags ?? [],
    requested_service_kinds: serviceIntent.requestedServiceKinds,
    primary_service_kind: serviceIntent.primaryServiceKind,
    service_notes: serviceIntent.serviceNotes,
    requested_quote_quantities: input.requestedQuoteQuantities ?? [],
    requested_by_date: input.requestedByDate ?? null,
    archived_at: null,
    created_at: FIXTURE_TIMESTAMP,
    updated_at: FIXTURE_TIMESTAMP,
  };
}

function createJobFileRecord(input: {
  id: string;
  jobId: string;
  originalName: string;
  normalizedName: string;
  fileKind: JobFileRecord["file_kind"];
  storagePath: string;
  matchedPartKey?: string;
}): JobFileRecord {
  return {
    id: input.id,
    job_id: input.jobId,
    organization_id: FIXTURE_ORGANIZATION_ID,
    uploaded_by: "fixture-user-client",
    blob_id: null,
    content_sha256: null,
    storage_bucket: FIXTURE_STORAGE_BUCKET,
    storage_path: input.storagePath,
    original_name: input.originalName,
    normalized_name: input.normalizedName,
    file_kind: input.fileKind,
    mime_type:
      input.fileKind === "drawing"
        ? "application/pdf"
        : input.originalName.endsWith(".step")
          ? "model/step"
          : "application/octet-stream",
    size_bytes: null,
    matched_part_key: input.matchedPartKey ?? null,
    created_at: FIXTURE_TIMESTAMP,
  };
}

function createDrawingPreview(stem: string): DrawingPreviewData {
  const pages = [1, 2].map((pageNumber) => ({
    pageNumber,
    storageBucket: FIXTURE_STORAGE_BUCKET,
    storagePath: `fixtures/${stem}-page-${pageNumber}.svg`,
    width: 1200,
    height: 900,
  }));

  return {
    pageCount: pages.length,
    thumbnail: pages[0] ?? null,
    pages,
  };
}

function createPartAggregate(input: {
  id: string;
  jobId: string;
  stem: string;
  quantity: number;
  partNumber: string;
  revision: string | null;
  description: string;
  material: string;
  finish?: string | null;
  requestedServiceKinds?: string[];
  primaryServiceKind?: string | null;
  serviceNotes?: string | null;
  requestedQuoteQuantities: number[];
  requestedByDate: string | null;
  vendorQuotes?: VendorQuoteAggregate[];
  cadAsset?: {
    fileName: string;
    normalizedName: string;
    storagePath: string;
  };
  drawingAsset?: {
    fileName: string;
    normalizedName: string;
    storagePath: string;
  };
  drawingPreview?: DrawingPreviewData;
}): {
  part: PartAggregate;
  summary: JobPartSummary;
  drawingPreview: DrawingPreviewData;
} {
  const cadAsset = input.cadAsset ?? {
    fileName: `${input.stem}.step`,
    normalizedName: `${input.stem}.step`,
    storagePath: "fixtures/demo-bracket.step",
  };
  const drawingAsset = input.drawingAsset ?? {
    fileName: `${input.stem}-drawing.pdf`,
    normalizedName: `${input.stem}-drawing.pdf`,
    storagePath: "fixtures/demo-bracket-drawing.pdf",
  };
  const cadFile = createJobFileRecord({
    id: `${input.id}-cad`,
    jobId: input.jobId,
    originalName: cadAsset.fileName,
    normalizedName: cadAsset.normalizedName,
    fileKind: "cad",
    storagePath: cadAsset.storagePath,
    matchedPartKey: input.stem,
  });
  const drawingFile = createJobFileRecord({
    id: `${input.id}-drawing`,
    jobId: input.jobId,
    originalName: drawingAsset.fileName,
    normalizedName: drawingAsset.normalizedName,
    fileKind: "drawing",
    storagePath: drawingAsset.storagePath,
    matchedPartKey: input.stem,
  });
  const drawingPreview = input.drawingPreview ?? createDrawingPreview("demo-bracket");
  const selectedOffer = findOfferById(
    input.vendorQuotes ?? [],
    input.vendorQuotes?.flatMap((quote) => quote.offers)[0]?.id ?? null,
  );
  const serviceIntent = normalizeRequestedServiceIntent({
    requestedServiceKinds: input.requestedServiceKinds ?? [],
    primaryServiceKind: input.primaryServiceKind ?? null,
    serviceNotes: input.serviceNotes ?? null,
  });

  return {
    part: {
      id: input.id,
      job_id: input.jobId,
      organization_id: FIXTURE_ORGANIZATION_ID,
      name: input.partNumber,
      normalized_key: input.stem,
      cad_file_id: cadFile.id,
      drawing_file_id: drawingFile.id,
      quantity: input.quantity,
      created_at: FIXTURE_TIMESTAMP,
      updated_at: FIXTURE_TIMESTAMP,
      cadFile,
      drawingFile,
      extraction: {
        id: `${input.id}-extraction`,
        part_id: input.id,
        organization_id: FIXTURE_ORGANIZATION_ID,
        extractor_version: "fixture-v1",
        extraction: {
          partNumber: input.partNumber,
          revision: input.revision,
          description: input.description,
          material: {
            raw: input.material,
            normalized: input.material,
            confidence: 0.98,
          },
        },
        confidence: 0.98,
        warnings: [],
        evidence: [],
        status: "approved",
        created_at: FIXTURE_TIMESTAMP,
        updated_at: FIXTURE_TIMESTAMP,
      },
      approvedRequirement: {
        id: `${input.id}-approved`,
        part_id: input.id,
        organization_id: FIXTURE_ORGANIZATION_ID,
        approved_by: "fixture-user-client",
        description: input.description,
        part_number: input.partNumber,
        revision: input.revision,
        material: input.material,
        finish: input.finish ?? null,
        tightest_tolerance_inch: 0.005,
        quantity: input.quantity,
        quote_quantities: input.requestedQuoteQuantities,
        requested_by_date: input.requestedByDate,
        applicable_vendors: ["xometry", "protolabs", "fictiv"],
        spec_snapshot: {
          requestedServiceKinds: serviceIntent.requestedServiceKinds,
          primaryServiceKind: serviceIntent.primaryServiceKind,
          serviceNotes: serviceIntent.serviceNotes,
          description: input.description,
          partNumber: input.partNumber,
          revision: input.revision,
          material: input.material,
        },
        approved_at: FIXTURE_TIMESTAMP,
        created_at: FIXTURE_TIMESTAMP,
        updated_at: FIXTURE_TIMESTAMP,
      },
      vendorQuotes: input.vendorQuotes ?? [],
    },
    summary: {
      jobId: input.jobId,
      partNumber: input.partNumber,
      revision: input.revision,
      description: input.description,
      requestedServiceKinds: serviceIntent.requestedServiceKinds,
      primaryServiceKind: serviceIntent.primaryServiceKind,
      serviceNotes: serviceIntent.serviceNotes,
      quantity: input.quantity,
      requestedQuoteQuantities: input.requestedQuoteQuantities,
      requestedByDate: input.requestedByDate,
      importedBatch: null,
      selectedSupplier: selectedOffer?.supplier ?? null,
      selectedPriceUsd: selectedOffer?.total_price_usd ?? null,
      selectedLeadTimeBusinessDays: selectedOffer?.lead_time_business_days ?? null,
    },
    drawingPreview,
  };
}

function createVendorQuoteAggregate(input: {
  id: string;
  partId: string;
  vendor: VendorName;
  supplier: string;
  requestedQuantity: number;
  unitPriceUsd: number;
  totalPriceUsd: number;
  leadTimeBusinessDays: number;
  domestic: boolean | null;
  offerId?: string;
  laneLabel?: string;
  quoteRunId?: string;
}): VendorQuoteAggregate {
  const offerId = input.offerId ?? `${input.id}-offer`;

  return {
    id: input.id,
    quote_run_id: input.quoteRunId ?? `${input.partId}-quote-run`,
    part_id: input.partId,
    organization_id: FIXTURE_ORGANIZATION_ID,
    vendor: input.vendor,
    requested_quantity: input.requestedQuantity,
    status: "instant_quote_received",
    unit_price_usd: input.unitPriceUsd,
    total_price_usd: input.totalPriceUsd,
    lead_time_business_days: input.leadTimeBusinessDays,
    quote_url: `https://example.test/${input.vendor}/${offerId}`,
    dfm_issues: [],
    notes: [],
    raw_payload:
      input.domestic === null
        ? {}
        : {
            domestic: input.domestic,
          },
    created_at: FIXTURE_TIMESTAMP,
    updated_at: FIXTURE_TIMESTAMP,
    offers: [
      {
        id: offerId,
        vendor_quote_result_id: input.id,
        organization_id: FIXTURE_ORGANIZATION_ID,
        offer_key: offerId,
        supplier: input.supplier,
        lane_label: input.laneLabel ?? "Standard",
        sourcing: input.domestic === true ? "Domestic" : input.domestic === false ? "International" : null,
        tier: "standard",
        quote_ref: `${input.vendor.toUpperCase()}-${offerId.slice(-4).toUpperCase()}`,
        quote_date: FIXTURE_TIMESTAMP.slice(0, 10),
        unit_price_usd: input.unitPriceUsd,
        total_price_usd: input.totalPriceUsd,
        lead_time_business_days: input.leadTimeBusinessDays,
        ship_receive_by: null,
        due_date: null,
        process: "CNC mill",
        material: "6061-T6 aluminum",
        finish: "As machined",
        tightest_tolerance: "+/-0.005",
        tolerance_source: "fixture",
        thread_callouts: null,
        thread_match_notes: null,
        notes: input.laneLabel ?? "Standard lane",
        sort_rank: 0,
        raw_payload:
          input.domestic === null
            ? {}
            : {
                domestic: input.domestic,
              },
        created_at: FIXTURE_TIMESTAMP,
        updated_at: FIXTURE_TIMESTAMP,
      },
    ],
    artifacts: [],
  };
}

function buildQuoteResultUrl(vendor: VendorName, laneId: string): string {
  return `https://example.test/${vendor}/${laneId}`;
}

function buildQuotedSampleVendorQuotes(partId: string, quoteRunId: string): VendorQuoteAggregate[] {
  return QUOTED_SAMPLE_LANES.map((lane, index) => {
    const resultId = `fx-quote-${lane.id}`;
    const offerId = `fx-offer-${lane.id}`;

    return {
      id: resultId,
      quote_run_id: quoteRunId,
      part_id: partId,
      organization_id: FIXTURE_ORGANIZATION_ID,
      vendor: lane.vendor,
      requested_quantity: lane.requestedQuantity,
      status: "instant_quote_received",
      unit_price_usd: lane.unitPriceUsd,
      total_price_usd: lane.totalPriceUsd,
      lead_time_business_days: lane.leadTimeBusinessDays,
      quote_url: buildQuoteResultUrl(lane.vendor, lane.id),
      dfm_issues: [],
      notes: lane.notes ? [lane.notes] : [],
      raw_payload: {
        source: QUOTED_SAMPLE_RFQ.projectSystem,
        sourcing: lane.sourcing,
      },
      created_at: FIXTURE_TIMESTAMP,
      updated_at: FIXTURE_TIMESTAMP,
      offers: [
        {
          id: offerId,
          vendor_quote_result_id: resultId,
          organization_id: FIXTURE_ORGANIZATION_ID,
          offer_key: offerId,
          supplier: lane.supplier,
          lane_label: lane.laneLabel,
          sourcing: lane.sourcing,
          tier: lane.tier,
          quote_ref: lane.quoteRef,
          quote_date: lane.quoteDate,
          unit_price_usd: lane.unitPriceUsd,
          total_price_usd: lane.totalPriceUsd,
          lead_time_business_days: lane.leadTimeBusinessDays,
          ship_receive_by: lane.shipReceiveBy,
          due_date: lane.dueDate,
          process: lane.process,
          material: lane.material,
          finish: lane.finish,
          tightest_tolerance: lane.tightestTolerance,
          tolerance_source: lane.toleranceSource,
          thread_callouts: lane.threadCallouts,
          thread_match_notes: lane.threadMatchNotes,
          notes: lane.notes,
          sort_rank: index,
          raw_payload: {
            source: QUOTED_SAMPLE_RFQ.projectSystem,
            laneId: lane.id,
          },
          created_at: FIXTURE_TIMESTAMP,
          updated_at: FIXTURE_TIMESTAMP,
        },
      ],
      artifacts: [],
    };
  });
}

function findOfferById(vendorQuotes: VendorQuoteAggregate[], offerId: string | null) {
  if (!offerId) {
    return null;
  }

  for (const quote of vendorQuotes) {
    const match = quote.offers.find((offer) => offer.id === offerId);

    if (match) {
      return match;
    }
  }

  return null;
}

function buildNeedsAttentionScenario(): FixtureState {
  const user = createFixtureUser({
    id: "fixture-user-client",
    email: "client.fixture@example.com",
    name: "Fixture Client",
    role: "client",
  });
  const session = createSession({
    user,
    role: "client",
  });
  const job = createJobRecord({
    id: "fx-job-needs-attention",
    createdBy: user.id,
    title: "FX-100 Bracket",
    description: "Customer drawing is attached, but the material callout needs cleanup.",
    status: "needs_spec_review",
    requestedQuoteQuantities: [12, 24],
    requestedByDate: "2026-03-24",
  });
  const project = createProjectRecord({
    id: "fx-project-attention",
    ownerUserId: user.id,
    name: "Request Cleanup",
    description: "Parts still being normalized before quote selection.",
  });
  const projectMembership: ProjectJobRecord = {
    id: "fx-membership-needs-attention",
    project_id: project.id,
    job_id: job.id,
    created_by: user.id,
    created_at: FIXTURE_TIMESTAMP,
  };
  const { part, summary, drawingPreview } = createPartAggregate({
    id: "fx-part-needs-attention",
    jobId: job.id,
    stem: "fx-100-bracket",
    quantity: 12,
    partNumber: "FX-100",
    revision: "A",
    description: "L-bracket with tapped holes",
    material: "6061-T6 aluminum",
    finish: "As machined",
    requestedQuoteQuantities: [12, 24],
    requestedByDate: "2026-03-24",
  });

  const partDetail: PartDetailAggregate = {
    job,
    files: [part.cadFile!, part.drawingFile!],
    summary,
    packages: [],
    part,
    quoteDataStatus: "available",
    quoteDataMessage: null,
    quoteDiagnostics: buildFixtureQuoteDiagnostics(part.vendorQuotes),
    projectIds: [project.id],
    drawingPreview,
    latestQuoteRequest: null,
    latestQuoteRun: null,
    revisionSiblings: [],
  };
  const clientActivityByJobId = {
    [job.id]: [
      createClientActivityEvent({
        id: "fx-event-needs-attention-created",
        jobId: job.id,
        eventType: "job.created",
        minutesAfterStart: 0,
      }),
      createClientActivityEvent({
        id: "fx-event-needs-attention-request",
        jobId: job.id,
        eventType: "client.part_request_updated",
        minutesAfterStart: 6,
        payload: {
          quantity: 12,
          requestedByDate: "2026-03-24",
        },
      }),
      createClientActivityEvent({
        id: "fx-event-needs-attention-extract-requested",
        jobId: job.id,
        eventType: "job.extraction_requested",
        minutesAfterStart: 11,
      }),
      createClientActivityEvent({
        id: "fx-event-needs-attention-extract-complete",
        jobId: job.id,
        eventType: "worker.extraction_completed",
        minutesAfterStart: 15,
        payload: {
          warningCount: 1,
        },
      }),
    ],
  };

  return {
    session,
    accessibleJobs: [job],
    accessibleProjects: [createProjectSummary(project, "owner", 1)],
    archivedJobs: [],
    archivedProjects: [],
    partSummariesByJobId: {
      [job.id]: summary,
    },
    projectJobMemberships: [projectMembership],
    partDetailsByJobId: {
      [job.id]: partDetail,
    },
    workspaceByJobId: {
      [job.id]: {
        job,
        files: partDetail.files,
        summary,
        part,
        quoteDataStatus: "available",
        quoteDataMessage: null,
        quoteDiagnostics: buildFixtureQuoteDiagnostics(part.vendorQuotes),
        projectIds: [project.id],
        drawingPreview,
        latestQuoteRequest: null,
        latestQuoteRun: null,
      },
    },
    clientActivityByJobId,
    sidebarPins: {
      projectIds: [],
      jobIds: [],
    },
    projectMembershipsByProjectId: {
      [project.id]: [
        {
          id: "fx-project-member-needs-attention",
          project_id: project.id,
          user_id: user.id,
          role: "owner",
          created_at: FIXTURE_TIMESTAMP,
        },
      ],
    },
    projectInvitesByProjectId: {
      [project.id]: [],
    },
  };
}

function buildQuotedScenario(): FixtureState {
  const user = createFixtureUser({
    id: "fixture-user-client",
    email: "client.fixture@example.com",
    name: "Fixture Client",
    role: "client",
  });
  const session = createSession({
    user,
    role: "client",
  });
  const project = createProjectRecord({
    id: "fx-project-quoted",
    ownerUserId: user.id,
    name: QUOTED_SAMPLE_PART.projectName,
    description: QUOTED_SAMPLE_PART.projectDescription,
  });

  const jobs: JobRecord[] = [];
  const partSummariesByJobId: Record<string, JobPartSummary> = {};
  const partDetailsByJobId: Record<string, PartDetailAggregate> = {};
  const workspaceByJobId: Record<string, ClientQuoteWorkspaceItem> = {};
  const clientActivityByJobId: Record<string, ClientActivityEvent[]> = {};
  const projectJobMemberships: ProjectJobRecord[] = [];
  const jobId = "fx-job-quoted-a";
  const partId = "fx-part-quoted-a";
  const quoteRunId = `${partId}-quote-run`;
  const vendorQuotes = buildQuotedSampleVendorQuotes(partId, quoteRunId);
  const selectedOffer = getQuotedSampleSelectedLane();
  const selectedOfferId = `fx-offer-${selectedOffer.id}`;
  const job = createJobRecord({
    id: jobId,
    createdBy: user.id,
    title: QUOTED_SAMPLE_PART.jobTitle,
    description: QUOTED_SAMPLE_PART.jobDescription,
    status: "quoting",
    requestedQuoteQuantities: [...QUOTED_SAMPLE_PART.requestedQuoteQuantities],
    requestedByDate: QUOTED_SAMPLE_PART.requestedByDate,
    projectId: project.id,
    selectedVendorQuoteOfferId: selectedOfferId,
  });
  const { part, summary, drawingPreview } = createPartAggregate({
    id: partId,
    jobId,
    stem: "1093-05589-02",
    quantity: QUOTED_SAMPLE_PART.quantity,
    partNumber: QUOTED_SAMPLE_PART.partNumber,
    revision: QUOTED_SAMPLE_PART.revision,
    description: QUOTED_SAMPLE_PART.description,
    material: QUOTED_SAMPLE_PART.material,
    finish: QUOTED_SAMPLE_PART.finish,
    requestedQuoteQuantities: [...QUOTED_SAMPLE_PART.requestedQuoteQuantities],
    requestedByDate: QUOTED_SAMPLE_PART.requestedByDate,
    vendorQuotes,
    cadAsset: QUOTED_SAMPLE_ASSETS.cad,
    drawingAsset: QUOTED_SAMPLE_ASSETS.drawing,
    drawingPreview: {
      pageCount: 0,
      thumbnail: null,
      pages: [],
    },
  });

  summary.selectedSupplier = selectedOffer.supplier;
  summary.selectedPriceUsd = selectedOffer.totalPriceUsd;
  summary.selectedLeadTimeBusinessDays = selectedOffer.leadTimeBusinessDays;

  const latestQuoteRun: QuoteRunRecord = {
    id: quoteRunId,
    quote_request_id: null,
    job_id: jobId,
    organization_id: FIXTURE_ORGANIZATION_ID,
    initiated_by: user.id,
    status: "completed",
    requested_auto_publish: false,
    created_at: FIXTURE_TIMESTAMP,
    updated_at: FIXTURE_TIMESTAMP,
  };

  jobs.push(job);
  projectJobMemberships.push({
    id: `${jobId}-project-link`,
    project_id: project.id,
    job_id: jobId,
    created_by: user.id,
    created_at: FIXTURE_TIMESTAMP,
  });
  partSummariesByJobId[job.id] = summary;
  partDetailsByJobId[job.id] = {
    job,
    files: [part.cadFile!, part.drawingFile!],
    summary,
    packages: [],
    part,
    quoteDataStatus: "available",
    quoteDataMessage: null,
    quoteDiagnostics: buildFixtureQuoteDiagnostics(part.vendorQuotes),
    projectIds: [project.id],
    drawingPreview,
    latestQuoteRequest: null,
    latestQuoteRun,
    revisionSiblings: [],
  };
  workspaceByJobId[job.id] = {
    job,
    files: [part.cadFile!, part.drawingFile!],
    summary,
    part,
    quoteDataStatus: "available",
    quoteDataMessage: null,
    quoteDiagnostics: buildFixtureQuoteDiagnostics(part.vendorQuotes),
    projectIds: [project.id],
    drawingPreview,
    latestQuoteRequest: null,
    latestQuoteRun,
  };
  clientActivityByJobId[job.id] = [
    createClientActivityEvent({
      id: `${job.id}-created`,
      jobId: job.id,
      eventType: "job.created",
      minutesAfterStart: 0,
    }),
    createClientActivityEvent({
      id: `${job.id}-extract-requested`,
      jobId: job.id,
      eventType: "job.extraction_requested",
      minutesAfterStart: 3,
    }),
    createClientActivityEvent({
      id: `${job.id}-extract-complete`,
      jobId: job.id,
      eventType: "worker.extraction_completed",
      minutesAfterStart: 7,
      payload: {
        warningCount: 0,
      },
    }),
    createClientActivityEvent({
      id: `${job.id}-quote-started`,
      jobId: job.id,
      eventType: "job.quote_run_started",
      minutesAfterStart: 18,
    }),
    createClientActivityEvent({
      id: `${job.id}-quote-complete`,
      jobId: job.id,
      eventType: "worker.quote_run_completed",
      minutesAfterStart: 31,
      payload: {
        successfulVendorQuotes: vendorQuotes.length,
        failedVendorQuotes: 0,
      },
    }),
  ];

  return {
    session,
    accessibleJobs: jobs,
    accessibleProjects: [createProjectSummary(project, "owner", jobs.length)],
    archivedJobs: [],
    archivedProjects: [],
    partSummariesByJobId,
    projectJobMemberships,
    partDetailsByJobId,
    workspaceByJobId,
    clientActivityByJobId,
    sidebarPins: {
      projectIds: [project.id],
      jobIds: [jobId],
    },
    projectMembershipsByProjectId: {
      [project.id]: [
        {
          id: "fx-project-member-quoted",
          project_id: project.id,
          user_id: user.id,
          role: "owner",
          created_at: FIXTURE_TIMESTAMP,
        },
      ],
    },
    projectInvitesByProjectId: {
      [project.id]: [],
    },
  };
}

function buildPublishedScenario(): FixtureState {
  const state = buildQuotedScenario();
  const publishedProject = createProjectRecord({
    id: "fx-project-published",
    ownerUserId: "fixture-user-client",
    name: "Production Plates",
    description: "Published customer review package.",
  });
  const publishedOffers = [
    createVendorQuoteAggregate({
      id: "fx-quote-published-xometry",
      partId: "fx-part-published",
      vendor: "xometry",
      supplier: "Xometry USA",
      requestedQuantity: 25,
      unitPriceUsd: 14.4,
      totalPriceUsd: 360,
      leadTimeBusinessDays: 9,
      domestic: true,
      offerId: "fx-offer-published-xometry",
      laneLabel: "Balanced",
    }),
    createVendorQuoteAggregate({
      id: "fx-quote-published-protolabs",
      partId: "fx-part-published",
      vendor: "protolabs",
      supplier: "Proto Labs",
      requestedQuantity: 25,
      unitPriceUsd: 16.1,
      totalPriceUsd: 402.5,
      leadTimeBusinessDays: 6,
      domestic: true,
      offerId: "fx-offer-published-protolabs",
      laneLabel: "Fastest",
    }),
  ];
  const job = createJobRecord({
    id: "fx-job-published",
    createdBy: "fixture-user-client",
    title: "FX-200 Production Plate",
    description: "Published part ready for checkout review.",
    status: "published",
    requestedQuoteQuantities: [25, 50],
    requestedByDate: "2026-04-02",
    projectId: publishedProject.id,
    selectedVendorQuoteOfferId: "fx-offer-published-xometry",
  });
  const { part, summary, drawingPreview } = createPartAggregate({
    id: "fx-part-published",
    jobId: job.id,
    stem: "fx-200-plate",
    quantity: 25,
    partNumber: "FX-200",
    revision: "B",
    description: "Production plate with finish callout",
    material: "7075 aluminum",
    finish: "Black anodize",
    requestedQuoteQuantities: [25, 50],
    requestedByDate: "2026-04-02",
    vendorQuotes: publishedOffers,
  });
  const selectedOffer = findOfferById(publishedOffers, job.selected_vendor_quote_offer_id);
  summary.selectedSupplier = selectedOffer?.supplier ?? null;
  summary.selectedPriceUsd = selectedOffer?.total_price_usd ?? null;
  summary.selectedLeadTimeBusinessDays = selectedOffer?.lead_time_business_days ?? null;

  const latestQuoteRun: QuoteRunRecord = {
    id: "fx-part-published-quote-run",
    quote_request_id: null,
    job_id: job.id,
    organization_id: FIXTURE_ORGANIZATION_ID,
    initiated_by: "fixture-user-client",
    status: "published",
    requested_auto_publish: true,
    created_at: FIXTURE_TIMESTAMP,
    updated_at: FIXTURE_TIMESTAMP,
  };
  const packageRecord: PublishedQuotePackageRecord = {
    id: "fx-package-published",
    job_id: job.id,
    quote_run_id: latestQuoteRun.id,
    organization_id: FIXTURE_ORGANIZATION_ID,
    published_by: "fixture-user-client",
    pricing_policy_id: "fixture-pricing-policy",
    auto_published: true,
    client_summary: "Published for client review.",
    created_at: FIXTURE_TIMESTAMP,
    published_at: FIXTURE_TIMESTAMP,
  };

  state.accessibleJobs = [job];
  state.accessibleProjects = [createProjectSummary(publishedProject, "owner", 1)];
  state.partSummariesByJobId = {
    [job.id]: summary,
  };
  state.projectJobMemberships = [
    {
      id: "fx-project-link-published",
      project_id: publishedProject.id,
      job_id: job.id,
      created_by: "fixture-user-client",
      created_at: FIXTURE_TIMESTAMP,
    },
  ];
  state.partDetailsByJobId = {
    [job.id]: {
      job,
      files: [part.cadFile!, part.drawingFile!],
      summary,
      packages: [packageRecord],
      part,
      quoteDataStatus: "available",
      quoteDataMessage: null,
      quoteDiagnostics: buildFixtureQuoteDiagnostics(part.vendorQuotes),
      projectIds: [publishedProject.id],
      drawingPreview,
      latestQuoteRequest: null,
      latestQuoteRun,
      revisionSiblings: [],
    },
  };
  state.workspaceByJobId = {
    [job.id]: {
      job,
      files: [part.cadFile!, part.drawingFile!],
      summary,
      part,
      quoteDataStatus: "available",
      quoteDataMessage: null,
      quoteDiagnostics: buildFixtureQuoteDiagnostics(part.vendorQuotes),
      projectIds: [publishedProject.id],
      drawingPreview,
      latestQuoteRequest: null,
      latestQuoteRun,
    },
  };
  state.clientActivityByJobId = {
    [job.id]: [
      createClientActivityEvent({
        id: "fx-job-published-created",
        jobId: job.id,
        eventType: "job.created",
        minutesAfterStart: 0,
      }),
      createClientActivityEvent({
        id: "fx-job-published-quote-started",
        jobId: job.id,
        eventType: "job.quote_run_started",
        minutesAfterStart: 14,
      }),
      createClientActivityEvent({
        id: "fx-job-published-quote-completed",
        jobId: job.id,
        eventType: "worker.quote_run_completed",
        minutesAfterStart: 26,
        payload: {
          successfulVendorQuotes: publishedOffers.length,
          failedVendorQuotes: 0,
        },
      }),
      createClientActivityEvent({
        id: "fx-job-published-package-published",
        jobId: job.id,
        packageId: packageRecord.id,
        eventType: "job.quote_package_published",
        minutesAfterStart: 34,
      }),
      createClientActivityEvent({
        id: "fx-job-published-selected",
        jobId: job.id,
        packageId: packageRecord.id,
        eventType: "client.quote_option_selected",
        minutesAfterStart: 41,
      }),
    ],
  };
  state.sidebarPins = {
    projectIds: [publishedProject.id],
    jobIds: [job.id],
  };
  state.projectMembershipsByProjectId = {
    [publishedProject.id]: [
      {
        id: "fx-project-member-published",
        project_id: publishedProject.id,
        user_id: "fixture-user-client",
        role: "owner",
        created_at: FIXTURE_TIMESTAMP,
      },
    ],
  };
  state.projectInvitesByProjectId = {
    [publishedProject.id]: [],
  };

  return state;
}

function buildEmptyScenario(): FixtureState {
  const user = createFixtureUser({
    id: "fixture-user-client",
    email: "client.fixture@example.com",
    name: "Fixture Client",
    role: "client",
  });

  return {
    session: createSession({ user, role: "client" }),
    accessibleJobs: [],
    accessibleProjects: [],
    archivedJobs: [],
    archivedProjects: [],
    partSummariesByJobId: {},
    projectJobMemberships: [],
    partDetailsByJobId: {},
    workspaceByJobId: {},
    clientActivityByJobId: {},
    sidebarPins: {
      projectIds: [],
      jobIds: [],
    },
    projectMembershipsByProjectId: {},
    projectInvitesByProjectId: {},
  };
}

function buildLandingScenario(): FixtureState {
  return {
    ...buildEmptyScenario(),
    session: createSession({ user: null }),
  };
}

const SCENARIO_BUILDERS: Record<FixtureScenarioId, () => FixtureState> = {
  "landing-anonymous": buildLandingScenario,
  "client-empty": buildEmptyScenario,
  "client-needs-attention": buildNeedsAttentionScenario,
  "client-quoted": buildQuotedScenario,
  "client-published": buildPublishedScenario,
};

function getState(scenarioId: FixtureScenarioId): FixtureState {
  const existing = scenarioStateCache.get(scenarioId);

  if (existing) {
    return existing;
  }

  const next = SCENARIO_BUILDERS[scenarioId]();
  scenarioStateCache.set(scenarioId, next);
  return next;
}

function syncProjectCounts(state: FixtureState) {
  const activeJobIds = new Set(state.accessibleJobs.map((job) => job.id));
  const archivedJobIds = new Set(state.archivedJobs.map((entry) => entry.job.id));

  state.accessibleProjects.forEach((project) => {
    project.partCount = state.projectJobMemberships.filter(
      (membership) => membership.project_id === project.project.id && activeJobIds.has(membership.job_id),
    ).length;
  });

  state.archivedProjects.forEach((project) => {
    project.partCount = state.projectJobMemberships.filter(
      (membership) => membership.project_id === project.project.id && archivedJobIds.has(membership.job_id),
    ).length;
  });
}

function getScenarioIdForSearch(search: string): FixtureScenarioId | null {
  if (!isFixtureModeEnvironmentEnabled()) {
    return null;
  }

  return getFixtureScenarioIdFromSearch(search);
}

function getActiveScenarioId(): FixtureScenarioId | null {
  if (typeof window === "undefined") {
    return null;
  }

  return getScenarioIdForSearch(window.location.search);
}

function requireRecord<T>(value: T | undefined | null, message: string): T {
  if (!value) {
    throw new Error(message);
  }

  return value;
}

function updateSelectedOfferSummary(state: FixtureState, jobId: string, offerId: string | null) {
  const summary = state.partSummariesByJobId[jobId];
  const workspaceItem = state.workspaceByJobId[jobId];
  const partDetail = state.partDetailsByJobId[jobId];
  const selectedOffer = workspaceItem ? findOfferById(workspaceItem.part?.vendorQuotes ?? [], offerId) : null;

  if (summary) {
    summary.selectedSupplier = selectedOffer?.supplier ?? null;
    summary.selectedPriceUsd = selectedOffer?.total_price_usd ?? null;
    summary.selectedLeadTimeBusinessDays = selectedOffer?.lead_time_business_days ?? null;
  }

  if (workspaceItem) {
    workspaceItem.job.selected_vendor_quote_offer_id = offerId;
  }

  if (partDetail) {
    partDetail.job.selected_vendor_quote_offer_id = offerId;
  }

  const activeJob = state.accessibleJobs.find((job) => job.id === jobId);

  if (activeJob) {
    activeJob.selected_vendor_quote_offer_id = offerId;
  }
}

export function isFixtureModeEnabled(): boolean {
  return Boolean(getActiveScenarioId());
}

export function isFixtureModeAvailable(): boolean {
  return isFixtureModeEnvironmentEnabled();
}

export function getFixtureScenarioIdFromSearch(search: string): FixtureScenarioId | null {
  const params = new URLSearchParams(search);
  const fixture = params.get("fixture");

  return CLIENT_WORKSPACE_FIXTURE_SCENARIOS.some((scenario) => scenario.id === fixture)
    ? (fixture as FixtureScenarioId)
    : null;
}

function isFixtureModeEnvironmentEnabled(): boolean {
  return import.meta.env.DEV || import.meta.env.MODE === "test";
}

export function getActiveFixtureScenario(): (typeof CLIENT_WORKSPACE_FIXTURE_SCENARIOS)[number] | null {
  const scenarioId = getActiveScenarioId();
  return CLIENT_WORKSPACE_FIXTURE_SCENARIOS.find((scenario) => scenario.id === scenarioId) ?? null;
}

export function getFixtureSessionDataForSearch(search: string): AppSessionData | null {
  const scenarioId = getScenarioIdForSearch(search);

  if (!scenarioId) {
    return null;
  }

  return cloneValue(getState(scenarioId).session);
}

export function getFixtureSessionData(): AppSessionData | null {
  if (typeof window === "undefined") {
    return null;
  }

  return getFixtureSessionDataForSearch(window.location.search);
}

export function resetClientWorkspaceFixtureStateForTests(): void {
  scenarioStateCache.clear();
}

export function getActiveClientWorkspaceGateway(): ClientWorkspaceGateway | null {
  const scenarioId = getActiveScenarioId();

  if (!scenarioId) {
    return null;
  }

  return {
    getSessionData: () => cloneValue(getState(scenarioId).session),
    fetchAccessibleJobs: async () => cloneValue(getState(scenarioId).accessibleJobs),
    fetchAccessibleProjects: async () => {
      syncProjectCounts(getState(scenarioId));
      return cloneValue(getState(scenarioId).accessibleProjects);
    },
    fetchArchivedJobs: async () => cloneValue(getState(scenarioId).archivedJobs),
    fetchArchivedProjects: async () => {
      syncProjectCounts(getState(scenarioId));
      return cloneValue(getState(scenarioId).archivedProjects);
    },
    fetchJobPartSummariesByJobIds: async (jobIds) =>
      cloneValue(
        jobIds
          .map((jobId) => getState(scenarioId).partSummariesByJobId[jobId])
          .filter((summary): summary is JobPartSummary => Boolean(summary)),
      ),
    fetchProjectJobMembershipsByJobIds: async (jobIds) =>
      cloneValue(
        getState(scenarioId).projectJobMemberships.filter((membership) => jobIds.includes(membership.job_id)),
      ),
    fetchSidebarPins: async () => cloneValue(getState(scenarioId).sidebarPins),
    pinProject: async (projectId) => {
      const state = getState(scenarioId);

      if (!state.sidebarPins.projectIds.includes(projectId)) {
        state.sidebarPins.projectIds.push(projectId);
      }
    },
    unpinProject: async (projectId) => {
      const state = getState(scenarioId);
      state.sidebarPins.projectIds = state.sidebarPins.projectIds.filter((value) => value !== projectId);
    },
    pinJob: async (jobId) => {
      const state = getState(scenarioId);

      if (!state.sidebarPins.jobIds.includes(jobId)) {
        state.sidebarPins.jobIds.push(jobId);
      }
    },
    unpinJob: async (jobId) => {
      const state = getState(scenarioId);
      state.sidebarPins.jobIds = state.sidebarPins.jobIds.filter((value) => value !== jobId);
    },
    fetchProject: async (projectId) =>
      cloneValue(
        requireRecord(
          getState(scenarioId).accessibleProjects.find((project) => project.project.id === projectId)?.project,
          `Fixture project ${projectId} was not found.`,
        ),
      ),
    fetchProjectMemberships: async (projectId) =>
      cloneValue(getState(scenarioId).projectMembershipsByProjectId[projectId] ?? []),
    fetchProjectAssigneeProfiles: async (projectId) => {
      const state = getState(scenarioId);
      const assigneeUserIds = [...new Set(
        state.projectJobMemberships
          .filter((membership) => membership.project_id === projectId)
          .map((membership) => membership.created_by),
      )];

      return cloneValue(
        assigneeUserIds.flatMap((userId) => {
          const sessionUser = state.session.user;

          if (!sessionUser || sessionUser.id !== userId) {
            return [];
          }

          return [
            {
              userId,
              email: sessionUser.email ?? null,
              givenName: null,
              familyName: null,
              fullName:
                typeof sessionUser.user_metadata?.full_name === "string"
                  ? sessionUser.user_metadata.full_name
                  : null,
            },
          ];
        }),
      );
    },
    fetchProjectInvites: async (projectId) =>
      cloneValue(getState(scenarioId).projectInvitesByProjectId[projectId] ?? []),
    fetchJobsByProject: async (projectId) => {
      const state = getState(scenarioId);
      const jobIds = state.projectJobMemberships
        .filter((membership) => membership.project_id === projectId)
        .map((membership) => membership.job_id);

      return cloneValue(state.accessibleJobs.filter((job) => jobIds.includes(job.id)));
    },
    fetchPartDetail: async (jobId) =>
      cloneValue(
        requireRecord(
          getState(scenarioId).partDetailsByJobId[jobId],
          `Fixture part detail ${jobId} was not found.`,
        ),
      ),
    fetchClientQuoteWorkspaceByJobIds: async (jobIds) =>
      cloneValue(
        jobIds
          .map((jobId) => getState(scenarioId).workspaceByJobId[jobId])
          .filter((item): item is ClientQuoteWorkspaceItem => Boolean(item)),
      ),
    fetchClientActivityEventsByJobIds: async (jobIds, limitPerJob = 6) => {
      const state = getState(scenarioId);

      return cloneValue(
        jobIds
          .flatMap((jobId) => state.clientActivityByJobId[jobId] ?? [])
          .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt))
          .reduce<ClientActivityEvent[]>((accumulator, event) => {
            const eventsForJob = accumulator.filter((candidate) => candidate.jobId === event.jobId).length;

            if (eventsForJob >= limitPerJob) {
              return accumulator;
            }

            accumulator.push(event);
            return accumulator;
          }, []),
      );
    },
    createProject: async (input) => {
      const state = getState(scenarioId);
      const projectId = `fixture-project-${Date.now().toString(36)}`;
      const project = createProjectRecord({
        id: projectId,
        ownerUserId: state.session.user?.id ?? "fixture-user-client",
        name: input.name,
        description: input.description ?? null,
      });

      state.accessibleProjects.unshift(createProjectSummary(project, "owner", 0));
      state.projectMembershipsByProjectId[projectId] = [
        {
          id: `${projectId}-membership`,
          project_id: projectId,
          user_id: state.session.user?.id ?? "fixture-user-client",
          role: "owner",
          created_at: FIXTURE_TIMESTAMP,
        },
      ];
      state.projectInvitesByProjectId[projectId] = [];

      return projectId;
    },
    updateProject: async (input) => {
      const projectSummary = requireRecord(
        getState(scenarioId).accessibleProjects.find((project) => project.project.id === input.projectId),
        `Fixture project ${input.projectId} was not found.`,
      );

      projectSummary.project.name = input.name;
      projectSummary.project.description = input.description ?? null;
      projectSummary.project.updated_at = new Date().toISOString();

      return input.projectId;
    },
    archiveProject: async (projectId) => {
      const state = getState(scenarioId);
      const projectIndex = state.accessibleProjects.findIndex((project) => project.project.id === projectId);
      const projectSummary = requireRecord(
        projectIndex >= 0 ? state.accessibleProjects[projectIndex] : null,
        `Fixture project ${projectId} was not found.`,
      );
      const archivedProject: ArchivedProjectSummary = {
        project: {
          ...projectSummary.project,
          archived_at: new Date().toISOString(),
        },
        currentUserRole: projectSummary.currentUserRole,
        partCount: projectSummary.partCount,
      };

      state.accessibleProjects.splice(projectIndex, 1);
      state.archivedProjects.unshift(archivedProject);
      syncProjectCounts(state);
      return projectId;
    },
    unarchiveProject: async (projectId) => {
      const state = getState(scenarioId);
      const archivedIndex = state.archivedProjects.findIndex((project) => project.project.id === projectId);
      const archivedProject = requireRecord(
        archivedIndex >= 0 ? state.archivedProjects[archivedIndex] : null,
        `Archived fixture project ${projectId} was not found.`,
      );

      state.archivedProjects.splice(archivedIndex, 1);
      state.accessibleProjects.unshift(
        createProjectSummary(
          {
            ...archivedProject.project,
            archived_at: null,
          },
          archivedProject.currentUserRole,
          archivedProject.partCount,
        ),
      );
      syncProjectCounts(state);
      return projectId;
    },
    dissolveProject: async (projectId) => {
      const state = getState(scenarioId);

      state.accessibleProjects = state.accessibleProjects.filter((project) => project.project.id !== projectId);
      state.projectJobMemberships = state.projectJobMemberships.filter((membership) => membership.project_id !== projectId);
      delete state.projectMembershipsByProjectId[projectId];
      delete state.projectInvitesByProjectId[projectId];
      state.accessibleJobs.forEach((job) => {
        if (job.project_id === projectId) {
          job.project_id = null;
        }
      });
      Object.values(state.workspaceByJobId).forEach((workspaceItem) => {
        workspaceItem.projectIds = workspaceItem.projectIds.filter((value) => value !== projectId);
        if (workspaceItem.job.project_id === projectId) {
          workspaceItem.job.project_id = null;
        }
      });
      Object.values(state.partDetailsByJobId).forEach((partDetail) => {
        partDetail.projectIds = partDetail.projectIds.filter((value) => value !== projectId);
        if (partDetail.job.project_id === projectId) {
          partDetail.job.project_id = null;
        }
      });
      syncProjectCounts(state);
      return projectId;
    },
    inviteProjectMember: async (input) => {
      const invite: ProjectInviteSummary = {
        id: `fixture-invite-${Date.now().toString(36)}`,
        email: input.email,
        role: input.role ?? "editor",
        status: "pending",
        token: `fixture-token-${Date.now().toString(36)}`,
        expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
        createdAt: new Date().toISOString(),
      };
      const invites = getState(scenarioId).projectInvitesByProjectId[input.projectId] ?? [];
      invites.unshift(invite);
      getState(scenarioId).projectInvitesByProjectId[input.projectId] = invites;

      const project = getState(scenarioId).accessibleProjects.find((entry) => entry.project.id === input.projectId);
      if (project) {
        project.inviteCount = invites.filter((entry) => entry.status === "pending").length;
      }

      return cloneValue(invite);
    },
    removeProjectMember: async (projectMembershipId) => {
      const state = getState(scenarioId);

      Object.keys(state.projectMembershipsByProjectId).forEach((projectId) => {
        state.projectMembershipsByProjectId[projectId] = state.projectMembershipsByProjectId[projectId].filter(
          (membership) => membership.id !== projectMembershipId,
        );
      });

      return projectMembershipId;
    },
    assignJobToProject: async ({ jobId, projectId }) => {
      const state = getState(scenarioId);
      const existing = state.projectJobMemberships.find(
        (membership) => membership.job_id === jobId && membership.project_id === projectId,
      );

      if (!existing) {
        state.projectJobMemberships.push({
          id: `fixture-project-job-${jobId}-${projectId}`,
          project_id: projectId,
          job_id: jobId,
          created_by: state.session.user?.id ?? "fixture-user-client",
          created_at: new Date().toISOString(),
        });
      }

      const job = state.accessibleJobs.find((entry) => entry.id === jobId);
      if (job) {
        job.project_id = projectId;
      }
      const workspaceItem = state.workspaceByJobId[jobId];
      if (workspaceItem && !workspaceItem.projectIds.includes(projectId)) {
        workspaceItem.projectIds.push(projectId);
        workspaceItem.job.project_id = projectId;
      }
      const partDetail = state.partDetailsByJobId[jobId];
      if (partDetail && !partDetail.projectIds.includes(projectId)) {
        partDetail.projectIds.push(projectId);
        partDetail.job.project_id = projectId;
      }
      syncProjectCounts(state);

      return projectId;
    },
    removeJobFromProject: async (jobId, projectId) => {
      const state = getState(scenarioId);
      state.projectJobMemberships = state.projectJobMemberships.filter(
        (membership) => !(membership.job_id === jobId && membership.project_id === projectId),
      );
      const remainingProjectId =
        state.projectJobMemberships.find((membership) => membership.job_id === jobId)?.project_id ?? null;
      const job = state.accessibleJobs.find((entry) => entry.id === jobId);
      if (job) {
        job.project_id = remainingProjectId;
      }
      const workspaceItem = state.workspaceByJobId[jobId];
      if (workspaceItem) {
        workspaceItem.projectIds = workspaceItem.projectIds.filter((value) => value !== projectId);
        workspaceItem.job.project_id = remainingProjectId;
      }
      const partDetail = state.partDetailsByJobId[jobId];
      if (partDetail) {
        partDetail.projectIds = partDetail.projectIds.filter((value) => value !== projectId);
        partDetail.job.project_id = remainingProjectId;
      }
      syncProjectCounts(state);
      return jobId;
    },
    archiveJob: async (jobId) => {
      const state = getState(scenarioId);
      const jobIndex = state.accessibleJobs.findIndex((job) => job.id === jobId);
      const job = requireRecord(jobIndex >= 0 ? state.accessibleJobs[jobIndex] : null, `Fixture job ${jobId} was not found.`);
      const summary = state.partSummariesByJobId[jobId] ?? null;
      const projectNames = state.projectJobMemberships
        .filter((membership) => membership.job_id === jobId)
        .map((membership) => state.accessibleProjects.find((project) => project.project.id === membership.project_id)?.project.name)
        .filter((name): name is string => Boolean(name));

      state.accessibleJobs.splice(jobIndex, 1);
      state.archivedJobs.unshift({
        job: {
          ...job,
          archived_at: new Date().toISOString(),
        },
        summary,
        projectNames,
      });
      syncProjectCounts(state);
      return jobId;
    },
    unarchiveJob: async (jobId) => {
      const state = getState(scenarioId);
      const archivedIndex = state.archivedJobs.findIndex((entry) => entry.job.id === jobId);
      const archivedJob = requireRecord(
        archivedIndex >= 0 ? state.archivedJobs[archivedIndex] : null,
        `Archived fixture job ${jobId} was not found.`,
      );

      state.archivedJobs.splice(archivedIndex, 1);
      state.accessibleJobs.unshift({
        ...archivedJob.job,
        archived_at: null,
      });
      syncProjectCounts(state);
      return jobId;
    },
    deleteArchivedJob: async (jobId) => {
      const state = getState(scenarioId);
      state.archivedJobs = state.archivedJobs.filter((entry) => entry.job.id !== jobId);
      delete state.partSummariesByJobId[jobId];
      delete state.workspaceByJobId[jobId];
      delete state.partDetailsByJobId[jobId];
      state.projectJobMemberships = state.projectJobMemberships.filter((membership) => membership.job_id !== jobId);
      syncProjectCounts(state);
      return jobId;
    },
    deleteArchivedJobs: async (jobIds) => {
      const normalizedIds = [...new Set(jobIds)];
      const state = getState(scenarioId);
      const archivedJobIds = new Set(state.archivedJobs.map((entry) => entry.job.id));
      const deletedJobIds: string[] = [];
      const failures = normalizedIds.flatMap((jobId) => {
        if (!archivedJobIds.has(jobId)) {
          return [
            {
              jobId,
              message: "Part not found, not archived, or you do not have permission to delete it.",
            },
          ];
        }

        deletedJobIds.push(jobId);
        return [];
      });

      deletedJobIds.forEach((jobId) => {
        state.archivedJobs = state.archivedJobs.filter((entry) => entry.job.id !== jobId);
        delete state.partSummariesByJobId[jobId];
        delete state.workspaceByJobId[jobId];
        delete state.partDetailsByJobId[jobId];
        state.projectJobMemberships = state.projectJobMemberships.filter((membership) => membership.job_id !== jobId);
      });

      syncProjectCounts(state);

      return {
        deletedJobIds,
        failures,
      };
    },
    setJobSelectedVendorQuoteOffer: async (jobId, offerId) => {
      updateSelectedOfferSummary(getState(scenarioId), jobId, offerId);
      return jobId;
    },
    updateClientPartRequest: async (input) => {
      const state = getState(scenarioId);
      const summary = requireRecord(state.partSummariesByJobId[input.jobId], `Fixture summary ${input.jobId} was not found.`);
      const workspaceItem = requireRecord(
        state.workspaceByJobId[input.jobId],
        `Fixture workspace item ${input.jobId} was not found.`,
      );
      const partDetail = requireRecord(
        state.partDetailsByJobId[input.jobId],
        `Fixture part detail ${input.jobId} was not found.`,
      );

      const metadata = sanitizeClientVisibleRfqLineItemExtendedMetadata(
        normalizeRfqLineItemExtendedMetadata(input),
      );
      const timestamp = new Date().toISOString();
      const workspaceRequirement = ensureFixtureClientRequirement(workspaceItem.part);
      const partDetailRequirement = ensureFixtureClientRequirement(partDetail.part);
      const previousPropertyState =
        workspaceRequirement?.projectPartProperties ??
        partDetailRequirement?.projectPartProperties ??
        null;
      const defaultPropertyState = {
        description: workspaceRequirement?.description ?? partDetailRequirement?.description ?? null,
        partNumber: workspaceRequirement?.partNumber ?? partDetailRequirement?.partNumber ?? null,
        material: workspaceRequirement?.material ?? partDetailRequirement?.material ?? "",
        finish: workspaceRequirement?.finish ?? partDetailRequirement?.finish ?? null,
        tightestToleranceInch:
          workspaceRequirement?.tightestToleranceInch ?? partDetailRequirement?.tightestToleranceInch ?? null,
        threads: workspaceRequirement?.threads ?? partDetailRequirement?.threads ?? null,
      };
      const nextDefaults = {
        ...defaultPropertyState,
        ...(previousPropertyState?.defaults ?? {}),
      };
      const nextOverrides = Object.fromEntries(
        (
          [
            ["description", input.description ?? null],
            ["partNumber", input.partNumber ?? null],
            ["material", input.material],
            ["finish", input.finish ?? null],
            ["tightestToleranceInch", input.tightestToleranceInch ?? null],
            ["threads", input.threads ?? null],
          ] as const
        ).filter((entry) => entry[1] !== nextDefaults[entry[0]])
      );
      const nextPropertyState = {
        defaults: nextDefaults,
        overrides: nextOverrides,
        createdAt: previousPropertyState?.createdAt ?? timestamp,
        updatedAt: timestamp,
      };

      summary.description = input.description;
      summary.partNumber = input.partNumber;
      summary.revision = input.revision;
      summary.requestedServiceKinds = [...input.requestedServiceKinds];
      summary.primaryServiceKind = input.primaryServiceKind;
      summary.serviceNotes = input.serviceNotes;
      summary.quantity = input.quantity;
      summary.requestedQuoteQuantities = [...input.requestedQuoteQuantities];
      summary.requestedByDate = input.requestedByDate;
      workspaceItem.job.requested_service_kinds = [...input.requestedServiceKinds];
      workspaceItem.job.primary_service_kind = input.primaryServiceKind;
      workspaceItem.job.service_notes = input.serviceNotes;
      workspaceItem.job.requested_quote_quantities = [...input.requestedQuoteQuantities];
      workspaceItem.job.requested_by_date = input.requestedByDate;
      workspaceItem.job.description = input.description;
      workspaceItem.job.updated_at = timestamp;
      partDetail.job.requested_service_kinds = [...input.requestedServiceKinds];
      partDetail.job.primary_service_kind = input.primaryServiceKind;
      partDetail.job.service_notes = input.serviceNotes;
      partDetail.job.requested_quote_quantities = [...input.requestedQuoteQuantities];
      partDetail.job.requested_by_date = input.requestedByDate;
      partDetail.job.description = input.description;
      partDetail.job.updated_at = timestamp;

      if (workspaceItem.part?.clientRequirement) {
        workspaceItem.part.clientRequirement = {
          ...workspaceItem.part.clientRequirement,
          description: input.description ?? null,
          partNumber: input.partNumber ?? null,
          revision: input.revision ?? null,
          material: input.material,
          finish: input.finish ?? null,
          threads: input.threads ?? null,
          tightestToleranceInch: input.tightestToleranceInch ?? null,
          process: input.process ?? null,
          notes: input.notes ?? null,
          quantity: input.quantity,
          quoteQuantities: [...input.requestedQuoteQuantities],
          requestedByDate: input.requestedByDate ?? null,
          projectPartProperties: nextPropertyState,
        };
      }

      if (workspaceItem.part?.approvedRequirement) {
        workspaceItem.part.approvedRequirement.description = input.description;
        workspaceItem.part.approvedRequirement.part_number = input.partNumber;
        workspaceItem.part.approvedRequirement.revision = input.revision;
        workspaceItem.part.approvedRequirement.material = input.material;
        workspaceItem.part.approvedRequirement.finish = input.finish;
        workspaceItem.part.approvedRequirement.tightest_tolerance_inch = input.tightestToleranceInch;
        workspaceItem.part.approvedRequirement.quantity = input.quantity;
        workspaceItem.part.approvedRequirement.quote_quantities = [...input.requestedQuoteQuantities];
        workspaceItem.part.approvedRequirement.requested_by_date = input.requestedByDate;
        workspaceItem.part.approvedRequirement.updated_at = timestamp;
        workspaceItem.part.approvedRequirement.spec_snapshot = {
          ...(workspaceItem.part.approvedRequirement.spec_snapshot as Record<string, unknown>),
          requestedServiceKinds: [...input.requestedServiceKinds],
          primaryServiceKind: input.primaryServiceKind,
          serviceNotes: input.serviceNotes,
          threads: input.threads ?? null,
          process: input.process,
          notes: input.notes,
          projectPartProperties: nextPropertyState,
          shipping: metadata.shipping,
          certifications: metadata.certifications,
          sourcing: metadata.sourcing,
          release: metadata.release,
        };
      }

      if (workspaceItem.part) {
        workspaceItem.part.quantity = input.quantity;
      }

      if (partDetail.part?.approvedRequirement) {
        partDetail.part.approvedRequirement = workspaceItem.part?.approvedRequirement ?? partDetail.part.approvedRequirement;
      }

      if (partDetail.part) {
        if (workspaceItem.part?.clientRequirement) {
          partDetail.part.clientRequirement = workspaceItem.part.clientRequirement;
        }
        partDetail.part.quantity = input.quantity;
        partDetail.part.updated_at = timestamp;
      }

      const existingEvents = state.clientActivityByJobId[input.jobId] ?? [];
      state.clientActivityByJobId[input.jobId] = [
        createClientActivityEvent({
          id: `fixture-event-request-update-${Date.now().toString(36)}`,
          jobId: input.jobId,
          eventType: "client.part_request_updated",
          minutesAfterStart: 90,
          payload: {
            requestedServiceKinds: input.requestedServiceKinds,
            primaryServiceKind: input.primaryServiceKind,
            quantity: input.quantity,
            requestedByDate: input.requestedByDate,
          },
        }),
        ...existingEvents,
      ];

      return input.jobId;
    },
    resetClientPartPropertyOverrides: async ({ jobId, fields }) => {
      const state = getState(scenarioId);
      const workspaceItem = requireRecord(
        state.workspaceByJobId[jobId],
        `Fixture workspace item ${jobId} was not found.`,
      );
      const partDetail = requireRecord(
        state.partDetailsByJobId[jobId],
        `Fixture part detail ${jobId} was not found.`,
      );
      const workspaceRequirement = ensureFixtureClientRequirement(workspaceItem.part);
      const partDetailRequirement = ensureFixtureClientRequirement(partDetail.part);
      const propertyState =
        workspaceRequirement?.projectPartProperties ?? partDetailRequirement?.projectPartProperties ?? null;

      if (!propertyState) {
        return jobId;
      }

      const nextOverrides = { ...propertyState.overrides };

      fields.forEach((field) => {
        delete nextOverrides[field];
      });

      const nextState = {
        ...propertyState,
        overrides: nextOverrides,
        updatedAt: new Date().toISOString(),
      };
      const timestamp = nextState.updatedAt;

      if (workspaceItem.part?.clientRequirement) {
        const defaults = propertyState.defaults;
        workspaceItem.part.clientRequirement = {
          ...workspaceItem.part.clientRequirement,
          description: fields.includes("description")
            ? (defaults.description as string | null | undefined) ?? null
            : workspaceItem.part.clientRequirement.description,
          partNumber: fields.includes("partNumber")
            ? (defaults.partNumber as string | null | undefined) ?? null
            : workspaceItem.part.clientRequirement.partNumber,
          material: fields.includes("material")
            ? ((defaults.material as string | null | undefined) ?? "")
            : workspaceItem.part.clientRequirement.material,
          finish: fields.includes("finish")
            ? (defaults.finish as string | null | undefined) ?? null
            : workspaceItem.part.clientRequirement.finish,
          threads: fields.includes("threads")
            ? (defaults.threads as string | null | undefined) ?? null
            : workspaceItem.part.clientRequirement.threads,
          tightestToleranceInch: fields.includes("tightestToleranceInch")
            ? ((defaults.tightestToleranceInch as number | null | undefined) ?? null)
            : workspaceItem.part.clientRequirement.tightestToleranceInch,
          projectPartProperties: nextState,
        };
      }

      if (partDetail.part && workspaceItem.part?.clientRequirement) {
        partDetail.part.clientRequirement = workspaceItem.part.clientRequirement;
        partDetail.part.updated_at = timestamp;
      }

      if (workspaceItem.part?.approvedRequirement) {
        workspaceItem.part.approvedRequirement.description =
          workspaceItem.part.clientRequirement?.description ?? null;
        workspaceItem.part.approvedRequirement.part_number =
          workspaceItem.part.clientRequirement?.partNumber ?? null;
        workspaceItem.part.approvedRequirement.material =
          workspaceItem.part.clientRequirement?.material ?? "";
        workspaceItem.part.approvedRequirement.finish =
          workspaceItem.part.clientRequirement?.finish ?? null;
        workspaceItem.part.approvedRequirement.tightest_tolerance_inch =
          workspaceItem.part.clientRequirement?.tightestToleranceInch ?? null;
        workspaceItem.part.approvedRequirement.updated_at = timestamp;
        workspaceItem.part.approvedRequirement.spec_snapshot = {
          ...(workspaceItem.part.approvedRequirement.spec_snapshot as Record<string, unknown>),
          description: workspaceItem.part.clientRequirement?.description ?? null,
          partNumber: workspaceItem.part.clientRequirement?.partNumber ?? null,
          material: workspaceItem.part.clientRequirement?.material ?? "",
          finish: workspaceItem.part.clientRequirement?.finish ?? null,
          threads: workspaceItem.part.clientRequirement?.threads ?? null,
          quoteDescription: workspaceItem.part.clientRequirement?.description ?? null,
          quoteFinish: workspaceItem.part.clientRequirement?.finish ?? null,
          tightestToleranceInch:
            workspaceItem.part.clientRequirement?.tightestToleranceInch ?? null,
          projectPartProperties: nextState,
        };
      }

      workspaceItem.job.updated_at = timestamp;
      partDetail.job.updated_at = timestamp;

      if (partDetail.part?.approvedRequirement && workspaceItem.part?.approvedRequirement) {
        partDetail.part.approvedRequirement = workspaceItem.part.approvedRequirement;
      }

      return jobId;
    },
  };
}
