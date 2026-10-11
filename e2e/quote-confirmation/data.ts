/** Synthetic metadata only. No file bytes, signed URLs, database or provider are used. */
import type { PartDetailAggregate } from "../../src/features/quotes/types";
import type { XometryBetaDispatchScope, XometryBetaModelUnits } from "../../src/features/quotes/xometry-beta-dispatch";

export const ID = {
  actor: "10000000-0000-4000-8000-000000000001",
  organization: "20000000-0000-4000-8000-000000000001",
  job: "30000000-0000-4000-8000-000000000001",
  part: "40000000-0000-4000-8000-000000000001",
};
export const POLICY = "founding-beta-2026-08-15";
export const FINGERPRINT = "a".repeat(64);
export const MILLIMETER_FINGERPRINT = "d".repeat(64);
export const CHANGED_FINGERPRINT = "c".repeat(64);
const timestamp = "2026-09-01T00:00:00Z";

export const detail: PartDetailAggregate = {
  job: {
    id: ID.job, organization_id: ID.organization, project_id: null, created_by: ID.actor,
    title: "Synthetic quote bracket", description: "Synthetic quote confirmation browser fixture",
    status: "ready_to_quote", source: "client_home", active_pricing_policy_id: null,
    selected_vendor_quote_offer_id: null, tags: [], requested_service_kinds: ["manufacturing_quote"],
    primary_service_kind: "manufacturing_quote", service_notes: null,
    requested_quote_quantities: [1], requested_by_date: null, archived_at: null,
    created_at: timestamp, updated_at: timestamp,
  },
  quoteDataStatus: "available", quoteDataMessage: null,
  quoteDiagnostics: { rawQuoteRowCount: 0, rawOfferCount: 0, plottableOfferCount: 0, excludedOfferCount: 0, excludedOffers: [], excludedReasonCounts: [] },
  // Preview intentionally has no attachments; part.cadFile below is only gating metadata.
  files: [], packages: [], projectIds: [], revisionSiblings: [],
  latestQuoteRequest: null, latestQuoteRun: null,
  drawingPreview: { pageCount: 0, thumbnail: null, pages: [] },
  summary: {
    jobId: ID.job, partNumber: "SYNTHETIC-001", revision: "A", description: "Synthetic quote bracket",
    quantity: 1, importedBatch: null, requestedQuoteQuantities: [1], requestedByDate: null,
    selectedSupplier: null, selectedPriceUsd: null, selectedLeadTimeBusinessDays: null,
    requestedServiceKinds: ["manufacturing_quote"], primaryServiceKind: "manufacturing_quote", serviceNotes: null,
  },
  part: {
    id: ID.part, job_id: ID.job, organization_id: ID.organization, name: "Synthetic quote bracket",
    normalized_key: "synthetic-quote-bracket", cad_file_id: "synthetic-cad-metadata", drawing_file_id: null,
    quantity: 1, created_at: timestamp, updated_at: timestamp, extraction: null,
    drawingFile: null, clientRequirement: null, clientExtraction: null, vendorQuotes: [],
    cadFile: {
      id: "synthetic-cad-metadata", job_id: ID.job, organization_id: ID.organization,
      file_kind: "cad", blob_id: null, storage_bucket: "synthetic-unused", storage_path: "no-file-exists",
      normalized_name: "synthetic-bracket.step", original_name: "synthetic-bracket.step", size_bytes: 0,
      mime_type: "model/step", content_sha256: "b".repeat(64), matched_part_key: null,
      uploaded_by: ID.actor, created_at: timestamp,
    },
    approvedRequirement: {
      id: "synthetic-requirement", part_id: ID.part, organization_id: ID.organization,
      approved_by: ID.actor, description: "Synthetic quote bracket", part_number: "SYNTHETIC-001",
      revision: "A", material: "6061-T6 aluminum", finish: "As machined", tightest_tolerance_inch: 0.005,
      quantity: 1, quote_quantities: [1], requested_by_date: null, applicable_vendors: ["xometry"],
      spec_snapshot: { process: "CNC milling" }, approved_at: timestamp, created_at: timestamp, updated_at: timestamp,
    },
  },
};

export function scope(units: XometryBetaModelUnits = "inch", changed = false): XometryBetaDispatchScope {
  return {
    organizationId: ID.organization, jobId: ID.job, partId: ID.part, provider: "xometry",
    requestedQuantity: 1, scopeVersion: 1, scopeFingerprint: changed ? CHANGED_FINGERPRINT : units === "inch" ? FINGERPRINT : MILLIMETER_FINGERPRINT,
    declaredModelUnits: units, policyRevision: POLICY, envelopeRevision: "xometry-controlled-beta-envelope.v1",
    scope: {
      schema: "quote-lane-scope.v1", vendor: "xometry", quantity: 1,
      destination: { confirmationRevision: "1", state: "confirmed", street: "123 Synthetic Avenue",
        city: "Testville", region: "AZ", postalCode: "85001", country: "US" },
      part: { id: ID.part, cad: { fileId: "synthetic-cad-metadata", sha256: "b".repeat(64),
        name: "synthetic-bracket.step", mimeType: "model/step", sizeBytes: 0 }, drawing: null },
      requirements: { id: "synthetic-requirement", capturedAt: timestamp,
        description: changed ? "Revised synthetic bracket" : "Synthetic quote bracket",
        partNumber: "SYNTHETIC-001", revision: changed ? "B" : "A", material: "6061-T6 aluminum",
        finish: "As machined", tightestToleranceInch: 0.005, requestedDeliveryDate: null,
        specification: { process: "CNC milling" } },
    },
  };
}

export function access(eligible = true) {
  return { schema: "quote-access.v1", actorUserId: ID.actor, organizationId: ID.organization, jobId: ID.job,
    state: eligible ? "eligible" : "blocked", source: eligible ? "free_beta" : null,
    reasonCode: eligible ? "eligible" : "free_policy_unavailable", policyRevision: eligible ? POLICY : null };
}
export function queued(created: boolean, fingerprint = FINGERPRINT) {
  return { accepted: true, created, deduplicated: !created, permitId: "synthetic-permit",
    quoteRequestId: "synthetic-request", quoteRunId: "synthetic-run", scopeFingerprint: fingerprint, status: "queued" };
}
