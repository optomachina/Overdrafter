import type { VendorName } from "./types.js";

/**
 * Leaf shape types for the OVD-457 provider dispatch envelope and the bounded
 * authorization handed to adapters. Kept free of runtime imports so `types.ts`
 * (and everything that type-checks it, including the root server project) does
 * not pull the preflight or adapter module graph.
 */

export const PROVIDER_DISPATCH_ENVELOPE_SCHEMA = "provider-dispatch-envelope.v1" as const;

export type ProviderDispatchFileRole = "cad" | "drawing";
export type ProviderDispatchModelUnits = "inch" | "millimeter";

export type ProviderDispatchSourceFile = {
  role: ProviderDispatchFileRole;
  fileId: string;
  sha256: string;
};

/** Exact outbound bytes. v1 discloses source bytes unchanged (`identity`). */
export type ProviderDispatchOutboundFile = {
  role: ProviderDispatchFileRole;
  sourceSha256: string;
  sha256: string;
  derivation: "identity";
};

export type ProviderDispatchEnvelope = {
  schema: typeof PROVIDER_DISPATCH_ENVELOPE_SCHEMA;
  provider: VendorName;
  /** Reviewed provider envelope; legacy text form is `${id}.v${version}`. */
  envelope: { id: string; version: number };
  /** OVD-379 admission policy revision and evidence reference at mint time. */
  admission: { policyRevision: string; evidenceReference: string };
  /** Founding Beta notice revision (the legacy Xometry `policyRevision` key). */
  noticeRevision: string;
  purpose: "quote_only";
  affirmations: { authorityToShare: true; nonExportControlled: true; quoteOnly: true };
  subject: { actorUserId: string; organizationId: string; jobId: string; partId: string };
  scope: {
    schema: "quote-lane-scope.v1";
    version: number;
    /** Opaque SQL-authoritative quote-lane scope fingerprint; never recomputed here. */
    fingerprint: string;
    requestedQuantity: number;
    declaredModelUnits: ProviderDispatchModelUnits;
  };
  sourceFiles: ProviderDispatchSourceFile[];
  outboundFiles: ProviderDispatchOutboundFile[];
  task: {
    quoteRequestId: string;
    quoteRunId: string;
    vendorQuoteResultId: string;
    quoteRequestLaneId: string;
    workQueueTaskId: string;
  };
  permit: { permitId: string; approvalReference: string };
  /** Opaque session-lease identifier. Never credentials or session material. */
  sessionBindingId: string;
  rollout: { capability: "automatic_quote_collection"; revision: number };
  issuedAt: string;
  expiresAt: string;
};

/** Bounded authority handed to the adapter seam. No credentials or file content. */
export type ProviderDispatchAuthorization = {
  permitId: string;
  provider: VendorName;
  envelopeFingerprint: string;
  expiresAt: string;
  sessionBindingId: string;
  envelope: ProviderDispatchEnvelope;
};
