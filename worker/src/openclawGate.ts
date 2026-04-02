import type { SupabaseClient } from "@supabase/supabase-js";

const TARGET_VENDORS = ["xometry", "fictiv"] as const;
const SUCCESS_STATUSES = new Set(["instant_quote_received", "official_quote_received"]);
const BLOCKING_FAILURE_CODES = new Set([
  "login_required",
  "captcha",
  "selector_failure",
  "unexpected_ui_state",
]);

export type OpenclawGateVendor = (typeof TARGET_VENDORS)[number];
export type OpenclawGateVendorClassification =
  | "real_quote"
  | "blocked"
  | "synthetic_or_stub"
  | "insufficient_evidence";

export type OpenclawGateDecision =
  | "pass"
  | "fail_anti_detection"
  | "fail_stub_or_simulation"
  | "fail_insufficient_data";

export type OpenclawGateVendorReport = {
  vendor: OpenclawGateVendor;
  classification: OpenclawGateVendorClassification;
  rowCount: number;
  blockedCount: number;
  realQuoteCount: number;
  syntheticCount: number;
  evidence: {
    statuses: string[];
    failureCodes: string[];
  };
};

export type OpenclawGateReport = {
  quoteRunId: string;
  generatedAt: string;
  decision: OpenclawGateDecision;
  reason: string;
  vendorReports: OpenclawGateVendorReport[];
  blockedVendorCount: number;
  realQuoteVendorCount: number;
  hasSyntheticOrStubSignal: boolean;
  concurrentSessionRisk: {
    detected: boolean;
    reason: string | null;
  };
};

type VendorQuoteResultRow = {
  id: string;
  vendor: string;
  status: string;
  total_price_usd: number | null;
  lead_time_business_days: number | null;
  quote_url: string | null;
  raw_payload: unknown;
  notes: unknown;
  updated_at: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function getFailureCode(rawPayload: unknown) {
  const record = asRecord(rawPayload);
  if (!record || typeof record.failureCode !== "string") {
    return null;
  }

  return record.failureCode;
}

function getPayloadMode(rawPayload: unknown) {
  const record = asRecord(rawPayload);
  if (!record || typeof record.mode !== "string") {
    return null;
  }

  return record.mode;
}

function getSource(rawPayload: unknown) {
  const record = asRecord(rawPayload);
  if (!record || typeof record.source !== "string") {
    return null;
  }

  return record.source;
}

function parseNotes(notes: unknown) {
  if (!Array.isArray(notes)) {
    return [];
  }

  return notes.filter((entry): entry is string => typeof entry === "string");
}

function isSyntheticOrStub(row: VendorQuoteResultRow) {
  const mode = getPayloadMode(row.raw_payload);
  const source = getSource(row.raw_payload);
  const notes = parseNotes(row.notes);
  const hasSimulatedNote = notes.some((note) => /simulated/i.test(note));
  const hasSimulatedUrl =
    typeof row.quote_url === "string" && row.quote_url.startsWith("simulated://");

  if (mode === "simulate" || hasSimulatedUrl || hasSimulatedNote) {
    return true;
  }

  if (row.vendor === "fictiv" && source === "fictiv-adapter" && row.status === "instant_quote_received") {
    return true;
  }

  return false;
}

function isRealQuote(row: VendorQuoteResultRow) {
  return (
    SUCCESS_STATUSES.has(row.status) &&
    typeof row.total_price_usd === "number" &&
    row.total_price_usd > 0 &&
    typeof row.lead_time_business_days === "number" &&
    row.lead_time_business_days > 0 &&
    !isSyntheticOrStub(row)
  );
}

function classifyVendorRows(vendor: OpenclawGateVendor, rows: VendorQuoteResultRow[]): OpenclawGateVendorReport {
  const blockedRows = rows.filter((row) => {
    const failureCode = getFailureCode(row.raw_payload);
    return failureCode ? BLOCKING_FAILURE_CODES.has(failureCode) : false;
  });
  const syntheticRows = rows.filter((row) => isSyntheticOrStub(row));
  const realRows = rows.filter((row) => isRealQuote(row));
  const failureCodes = Array.from(
    new Set(
      rows
        .map((row) => getFailureCode(row.raw_payload))
        .filter((code): code is string => typeof code === "string"),
    ),
  );
  const statuses = Array.from(new Set(rows.map((row) => row.status)));

  let classification: OpenclawGateVendorClassification = "insufficient_evidence";
  if (syntheticRows.length > 0) {
    classification = "synthetic_or_stub";
  } else if (realRows.length > 0) {
    classification = "real_quote";
  } else if (blockedRows.length > 0) {
    classification = "blocked";
  }

  return {
    vendor,
    classification,
    rowCount: rows.length,
    blockedCount: blockedRows.length,
    realQuoteCount: realRows.length,
    syntheticCount: syntheticRows.length,
    evidence: {
      statuses,
      failureCodes,
    },
  };
}

function detectConcurrentSessionRisk(rows: VendorQuoteResultRow[]) {
  const xometryRows = rows.filter((row) => row.vendor === "xometry");
  if (xometryRows.length < 2) {
    return {
      detected: false,
      reason: null,
    };
  }

  const hasBlockingAuthSignal = xometryRows.some((row) => {
    const failureCode = getFailureCode(row.raw_payload);
    return failureCode === "login_required" || failureCode === "captcha";
  });
  const hasNonBlockedProgress = xometryRows.some(
    (row) => SUCCESS_STATUSES.has(row.status) || row.status === "running",
  );

  if (hasBlockingAuthSignal && hasNonBlockedProgress) {
    return {
      detected: true,
      reason:
        "Xometry rows show both login/captcha barriers and non-blocked progress in the same run window.",
    };
  }

  return {
    detected: false,
    reason: null,
  };
}

export function evaluateOpenclawGateFromRows(
  quoteRunId: string,
  rows: VendorQuoteResultRow[],
): OpenclawGateReport {
  const vendorReports = TARGET_VENDORS.map((vendor) =>
    classifyVendorRows(
      vendor,
      rows.filter((row) => row.vendor === vendor),
    ),
  );
  const blockedVendorCount = vendorReports.filter((report) => report.classification === "blocked").length;
  const realQuoteVendorCount = vendorReports.filter(
    (report) => report.classification === "real_quote",
  ).length;
  const hasSyntheticOrStubSignal = vendorReports.some(
    (report) => report.classification === "synthetic_or_stub",
  );
  const concurrentSessionRisk = detectConcurrentSessionRisk(rows);

  let decision: OpenclawGateDecision = "fail_insufficient_data";
  let reason = "Gate did not receive enough real quote evidence for all required vendors.";

  if (realQuoteVendorCount >= TARGET_VENDORS.length) {
    decision = "pass";
    reason = "Both target vendors persisted real quote data with price and lead time.";
  } else if (blockedVendorCount >= 2) {
    decision = "fail_anti_detection";
    reason = "Anti-detection barriers blocked two or more target vendors.";
  } else if (hasSyntheticOrStubSignal) {
    decision = "fail_stub_or_simulation";
    reason = "At least one target vendor produced simulated or stub quote evidence.";
  }

  return {
    quoteRunId,
    generatedAt: new Date().toISOString(),
    decision,
    reason,
    vendorReports,
    blockedVendorCount,
    realQuoteVendorCount,
    hasSyntheticOrStubSignal,
    concurrentSessionRisk,
  };
}

export async function evaluateOpenclawGate(
  supabase: SupabaseClient,
  quoteRunId: string,
): Promise<OpenclawGateReport> {
  const { data, error } = await supabase
    .from("vendor_quote_results")
    .select(
      "id,vendor,status,total_price_usd,lead_time_business_days,quote_url,raw_payload,notes,updated_at",
    )
    .eq("quote_run_id", quoteRunId)
    .in("vendor", [...TARGET_VENDORS]);

  if (error) {
    throw error;
  }

  return evaluateOpenclawGateFromRows(quoteRunId, (data ?? []) as VendorQuoteResultRow[]);
}
