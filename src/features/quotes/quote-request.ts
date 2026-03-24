import type {
  ClientQuoteRequestStatus,
  PartAggregate,
  QuoteRequestRecord,
  QuoteRunRecord,
} from "@/features/quotes/types";
import type {
  JobRecord,
} from "@/features/quotes/types";

export type QuoteRequestActionKind = "request" | "retry" | "cancel" | "none";

const GENERIC_QUOTE_REQUEST_FAILURE_REASON =
  "Quote collection did not return a usable Xometry response.";

const CLIENT_SAFE_FAILURE_REASONS = new Set([
  "Xometry could not return an automated quote and needs manual follow-up.",
  "Xometry quote collection failed before a usable response was received.",
  "Quote collection ended without a usable Xometry response.",
  GENERIC_QUOTE_REQUEST_FAILURE_REASON,
]);

export type QuoteRequestViewModel = {
  status: ClientQuoteRequestStatus;
  tone: "ready" | "warning" | "blocked";
  label: string;
  detail: string;
  action: {
    kind: QuoteRequestActionKind;
    label: string | null;
    disabled: boolean;
  };
  blockerReasons: string[];
};

function hasQuoteCompatibleServiceKinds(job: JobRecord) {
  return (job.requested_service_kinds ?? []).some((serviceKind) =>
    serviceKind === "manufacturing_quote" || serviceKind === "sourcing_only",
  );
}

function buildBlockerReasons(input: {
  job: JobRecord;
  part: PartAggregate | null;
}): string[] {
  const { job, part } = input;
  const reasons: string[] = [];
  const requirement = part?.approvedRequirement ?? null;

  if (job.archived_at) {
    reasons.push("Archived parts cannot request quotes.");
  }

  if (job.status === "closed" || job.status === "client_selected") {
    reasons.push("This part is already closed to new quote requests.");
  }

  if (!part) {
    reasons.push("This part is still being prepared.");
    return reasons;
  }

  if (!hasQuoteCompatibleServiceKinds(job)) {
    reasons.push("Only manufacturing quote and sourcing-only requests can start vendor quoting.");
  }

  if (!part.cadFile) {
    reasons.push("Upload a CAD model before requesting a quote.");
  }

  if (!requirement) {
    reasons.push("Finish the request details so OverDrafter can create approved quote requirements.");
    return reasons;
  }

  if (!requirement.applicable_vendors.includes("xometry")) {
    reasons.push("Xometry is not available for this part in its current package state.");
  }

  if (
    hasQuoteCompatibleServiceKinds(job) &&
    requirement.material.trim().length === 0
  ) {
    reasons.push("Add material before requesting a quote.");
  }

  return reasons;
}

function deriveFallbackStatus(input: {
  job: JobRecord;
  latestQuoteRun: QuoteRunRecord | null;
}): ClientQuoteRequestStatus {
  const { job, latestQuoteRun } = input;

  if (!latestQuoteRun) {
    return "not_requested";
  }

  if (latestQuoteRun.status === "failed") {
    return "failed";
  }

  if (
    latestQuoteRun.status === "queued" ||
    latestQuoteRun.status === "running" ||
    job.status === "quoting" ||
    job.status === "awaiting_vendor_manual_review"
  ) {
    return "requesting";
  }

  if (
    latestQuoteRun.status === "completed" ||
    latestQuoteRun.status === "published" ||
    job.status === "internal_review" ||
    job.status === "published" ||
    job.status === "client_selected" ||
    job.status === "closed"
  ) {
    return "received";
  }

  return "not_requested";
}

function requestStatusLabel(status: ClientQuoteRequestStatus) {
  switch (status) {
    case "queued":
      return "Queued";
    case "requesting":
      return "Requesting";
    case "received":
      return "Quoted";
    case "failed":
      return "Failed";
    case "canceled":
      return "Canceled";
    case "not_requested":
    default:
      return "Not requested";
  }
}

function sanitizeClientFailureReason(failureReason: string | null | undefined) {
  const trimmedReason = failureReason?.trim() ?? "";

  if (trimmedReason.length === 0) {
    return GENERIC_QUOTE_REQUEST_FAILURE_REASON;
  }

  return CLIENT_SAFE_FAILURE_REASONS.has(trimmedReason)
    ? trimmedReason
    : GENERIC_QUOTE_REQUEST_FAILURE_REASON;
}

export function buildQuoteRequestViewModel(input: {
  job: JobRecord;
  part: PartAggregate | null;
  latestQuoteRequest: QuoteRequestRecord | null;
  latestQuoteRun: QuoteRunRecord | null;
}): QuoteRequestViewModel {
  const blockerReasons = buildBlockerReasons({
    job: input.job,
    part: input.part,
  });
  const latestRequest = input.latestQuoteRequest;
  const status = latestRequest?.status ?? deriveFallbackStatus(input);

  switch (status) {
    case "queued":
      return {
        status,
        tone: "warning",
        label: requestStatusLabel(status),
        detail: "Your quote request was accepted and is queued for the worker.",
        action: {
          kind: "cancel",
          label: "Cancel request",
          disabled: false,
        },
        blockerReasons,
      };
    case "requesting":
      return {
        status,
        tone: "warning",
        label: requestStatusLabel(status),
        detail: "Xometry quote collection is in progress for the current package.",
        action: {
          kind: "cancel",
          label: "Cancel request",
          disabled: false,
        },
        blockerReasons,
      };
    case "received":
      return {
        status,
        tone: "ready",
        label: requestStatusLabel(status),
        detail: "A quote response was received and is moving through review.",
        action: {
          kind: "none",
          label: "Quoted",
          disabled: true,
        },
        blockerReasons,
      };
    case "failed":
      return {
        status,
        tone: blockerReasons.length > 0 ? "blocked" : "warning",
        label: requestStatusLabel(status),
        detail: sanitizeClientFailureReason(latestRequest?.failure_reason),
        action: {
          kind: "retry",
          label: "Retry quote",
          disabled: blockerReasons.length > 0,
        },
        blockerReasons,
      };
    case "canceled":
      return {
        status,
        tone: blockerReasons.length > 0 ? "blocked" : "warning",
        label: requestStatusLabel(status),
        detail: "This quote request was canceled before a response was received.",
        action: {
          kind: "retry",
          label: "Retry quote",
          disabled: blockerReasons.length > 0,
        },
        blockerReasons,
      };
    case "not_requested":
    default:
      return {
        status: "not_requested",
        tone: blockerReasons.length > 0 ? "blocked" : "ready",
        label: requestStatusLabel("not_requested"),
        detail:
          blockerReasons.length > 0
            ? blockerReasons[0]!
            : "Request a quote to send this part to Xometry.",
        action: {
          kind: "request",
          label: "Request quote",
          disabled: blockerReasons.length > 0,
        },
        blockerReasons,
      };
  }
}
