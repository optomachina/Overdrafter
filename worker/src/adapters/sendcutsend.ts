import { getAuthorizedLiveEvaluationFiles } from "../liveEvaluationFiles.js";
import { resolveRequirementProcess } from "../partContext.js";
import {
  VendorAutomationError,
  type VendorQuoteAdapterInput,
  type VendorQuoteAdapterOffer,
  type VendorQuoteAdapterOutput,
} from "../types.js";
import { VendorAdapter } from "./base.js";
import {
  evaluateSendCutSendCncEnvelope,
  inspectSendCutSendStepGeometry,
  SENDCUTSEND_CNC_ENVELOPE,
  type SendCutSendEnvelopeDecision,
} from "./sendcutsendEnvelope.js";

export const SENDCUTSEND_AUTOMATION_VERSION = "sendcutsend-evaluation-preflight-v1";

const CAPTCHA_PATTERN = /\b(captcha|verify you are human|security challenge)\b/i;
const LOGIN_PATTERN = /\b(log in|login|sign in|signin|create account|password)\b/i;
const MANUAL_REVIEW_PATTERN = /\b(manual review|engineering review|quote request received|reviewing your part)\b/i;
const CONFIGURATION_PATTERN = /\b(select material|configure (?:your )?part|choose (?:a )?finish|add material|configuration required)\b/i;
const PRICE_PATTERN = /(?:\$\s*|\bUSD\s*)([\d,]+(?:\.\d{1,2})?)/gi;
const EXACT_LEAD_TIME_PATTERN = /\b(\d{1,3})\s+(?:business|production|working)\s+days?\b/i;
const LEAD_TIME_RANGE_PATTERN = /\b\d{1,3}\s*[-–]\s*\d{1,3}\s+(?:business|production|working)\s+days?\b/i;

type SendCutSendPortalState =
  | "captcha"
  | "configuration_required"
  | "login_required"
  | "manual_review"
  | "quote_ready"
  | "unknown";

export type SendCutSendQuoteContainer = {
  availability: "purchasable" | "unavailable";
  domMatchId: string;
  selector: string;
  providerOptionId: string | null;
  providerLabel: string | null;
  quoteRef: string | null;
  quoteUrl: string | null;
  text: string;
};

export type SendCutSendOfferNormalization =
  | { ok: true; offers: VendorQuoteAdapterOffer[] }
  | {
    ok: false;
    reason: "duplicate_provider_option_id" | "purchasable_offer_unparseable";
    providerOptionId: string | null;
  };

type SendCutSendValidityEvidence = {
  quotedAt: string | null;
  validUntil: string | null;
  validityDurationDays: number | null;
  validitySource: "vendor_date" | "vendor_duration" | null;
  validityTerms: string | null;
};

function excerpt(text: string, maxLength = 500) {
  return text.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function parsePrice(text: string, quantity: number) {
  const matches = [...text.matchAll(PRICE_PATTERN)];
  const captured = matches.length === 1 ? matches[0]?.[1] : null;
  const price = captured ? Number.parseFloat(captured.replaceAll(",", "")) : Number.NaN;
  if (!Number.isFinite(price) || price <= 0) return null;

  const matchIndex = matches[0]?.index ?? 0;
  const context = text.slice(matchIndex, matchIndex + (matches[0]?.[0].length ?? 0) + 32);
  const isUnit = /\b(?:per\s+(?:part|unit)|each)\b/i.test(context);
  const safeQuantity = Math.max(1, quantity);
  return isUnit
    ? { unitPriceUsd: price, totalPriceUsd: Math.round(price * safeQuantity * 100) / 100 }
    : { unitPriceUsd: Math.round((price / safeQuantity) * 100) / 100, totalPriceUsd: price };
}

function parseLeadTime(text: string) {
  if (LEAD_TIME_RANGE_PATTERN.test(text)) return null;
  const captured = EXACT_LEAD_TIME_PATTERN.exec(text)?.[1];
  const days = captured ? Number.parseInt(captured, 10) : Number.NaN;
  return Number.isInteger(days) && days > 0 ? days : null;
}

function containerFingerprint(container: SendCutSendQuoteContainer) {
  return JSON.stringify([
    container.domMatchId,
    container.availability,
    container.providerOptionId,
    container.providerLabel,
    container.quoteRef,
    container.quoteUrl,
    container.text,
  ]);
}

/**
 * Normalizes the complete purchasable offer set. Exact duplicate DOM matches
 * are collapsed, but conflicting provider IDs or an unparseable purchasable
 * card fail the entire set closed. Only explicit unavailable cards are omitted.
 */
export function normalizeSendCutSendOffers(
  containers: SendCutSendQuoteContainer[],
  requestedQuantity: number,
): SendCutSendOfferNormalization {
  const exactMatches = new Set<string>();
  const providerIds = new Set<string>();
  const offers: VendorQuoteAdapterOffer[] = [];
  for (const container of containers) {
    const fingerprint = containerFingerprint(container);
    if (exactMatches.has(fingerprint)) {
      continue;
    }
    exactMatches.add(fingerprint);
    if (container.availability === "unavailable") {
      continue;
    }

    const providerLabel = container.providerLabel?.replace(/\s+/g, " ").trim() || null;
    const providerOptionId = container.providerOptionId?.trim() || providerLabel;
    const price = parsePrice(container.text, requestedQuantity);
    if (!providerLabel || !providerOptionId || !price) {
      return { ok: false, reason: "purchasable_offer_unparseable", providerOptionId };
    }
    if (providerIds.has(providerOptionId)) {
      return { ok: false, reason: "duplicate_provider_option_id", providerOptionId };
    }

    providerIds.add(providerOptionId);
    const leadTimeBusinessDays = parseLeadTime(container.text);
    offers.push({
      providerOptionId,
      providerLabel,
      quoteRef: container.quoteRef?.trim() || null,
      quoteUrl: container.quoteUrl,
      ...price,
      leadTimeBusinessDays,
      shipReceiveBy: null,
      tier: providerLabel,
      sourcing: "automated",
      geographicOrigin: "unknown",
      sortRank: offers.length,
      provenance: {
        containerSelector: container.selector,
        providerOptionIdSource: container.providerOptionId ? "attribute" : "provider_label",
        priceSource: "selector",
        leadTimeSource: leadTimeBusinessDays === null ? "none" : "selector",
        geographicOriginSource: "none",
      },
      rawPayload: { providerText: excerpt(container.text), requestedQuantity },
    });
  }
  return { ok: true, offers };
}

/** Future portal work may only trust the explicit HTTPS application origin. */
export function isApprovedSendCutSendOrigin(rawUrl: string) {
  try {
    const url = new URL(rawUrl);
    return url.origin === "https://app.sendcutsend.com";
  } catch {
    return false;
  }
}

/** Retains explicit ISO quote/expiration dates or provider-stated whole-day validity only. */
export function parseSendCutSendValidityEvidence(text: string): SendCutSendValidityEvidence {
  const quotedDate = /\bquoted\s+(?:at|on)\s+(\d{4}-\d{2}-\d{2})\b/i.exec(text)?.[1] ?? null;
  const validUntilMatch = /\bvalid\s+(?:until|through)\s+(\d{4}-\d{2}-\d{2})\b/i.exec(text);
  const durationMatch = /\bvalid\s+for\s+(\d{1,3})\s+days?\b/i.exec(text);
  const quotedAt = quotedDate && Number.isFinite(Date.parse(quotedDate)) ? quotedDate : null;
  const validUntilDate = validUntilMatch?.[1] ?? null;
  const validUntil = validUntilDate && Number.isFinite(Date.parse(validUntilDate))
    ? validUntilDate
    : null;
  const duration = durationMatch?.[1] ? Number.parseInt(durationMatch[1], 10) : null;
  if (validUntil) {
    return {
      quotedAt,
      validUntil,
      validityDurationDays: null,
      validitySource: "vendor_date",
      validityTerms: validUntilMatch?.[0] ?? null,
    };
  }
  if (duration && duration > 0) {
    return {
      quotedAt,
      validUntil: null,
      validityDurationDays: duration,
      validitySource: "vendor_duration",
      validityTerms: durationMatch?.[0] ?? null,
    };
  }
  return {
    quotedAt,
    validUntil: null,
    validityDurationDays: null,
    validitySource: null,
    validityTerms: null,
  };
}

export function classifySendCutSendPortalState(input: {
  bodyText: string;
  url: string;
  passwordInputCount: number;
  offerCount: number;
}): SendCutSendPortalState {
  if (CAPTCHA_PATTERN.test(input.bodyText)) return "captcha";
  if (/\b(?:login|sign-?in)\b/i.test(input.url) || (input.passwordInputCount > 0 && LOGIN_PATTERN.test(input.bodyText))) {
    return "login_required";
  }
  if (input.offerCount > 0) return "quote_ready";
  if (MANUAL_REVIEW_PATTERN.test(input.bodyText)) return "manual_review";
  if (CONFIGURATION_PATTERN.test(input.bodyText)) return "configuration_required";
  return "unknown";
}

export class SendCutSendAdapter extends VendorAdapter {
  async quote(input: VendorQuoteAdapterInput): Promise<VendorQuoteAdapterOutput> {
    if (this.config.workerMode !== "live") {
      return this.emptyResult(input, null, "manual_vendor_followup", "live_evaluation_not_enabled");
    }

    const files = getAuthorizedLiveEvaluationFiles(input);
    if (input.executionContext !== "live_evaluation" || !files) {
      throw this.failure(
        input,
        "unexpected_ui_state",
        "provider_neutral_authorization_unavailable",
        "SendCutSend production dispatch requires the unmerged provider-neutral permit and immediate preflight contract.",
      );
    }

    const decision = evaluateSendCutSendCncEnvelope({
      fileName: files.cad.name,
      process: resolveRequirementProcess(input.requirement.spec_snapshot),
      material: input.requirement.material,
      finish: input.requirement.finish,
      tightestToleranceInch: input.requirement.tightest_tolerance_inch,
      quantity: input.requestedQuantity,
      drawingIncluded: files.drawing !== null,
      accountMode: SENDCUTSEND_CNC_ENVELOPE.accountMode,
      geometry: inspectSendCutSendStepGeometry({ fileName: files.cad.name, buffer: files.cad.buffer }),
    });
    if (!decision.eligible) {
      return this.emptyResult(input, decision, "manual_vendor_followup", "outside_certified_cnc_envelope");
    }

    return this.emptyResult(
      input,
      decision,
      "manual_vendor_followup",
      "provider_configuration_contract_uncertified",
    );
  }

  private emptyResult(
    input: VendorQuoteAdapterInput,
    decision: SendCutSendEnvelopeDecision | null,
    status: "manual_review_pending" | "manual_vendor_followup",
    reason: string,
  ): VendorQuoteAdapterOutput {
    let note = "SendCutSend requires authorized evaluation or finite manual follow-up.";
    if (reason === "outside_certified_cnc_envelope") {
      note = "The package is outside the certified SendCutSend CNC envelope and was not disclosed.";
    } else if (reason === "provider_configuration_contract_uncertified") {
      note = "Provider configuration selectors, readback, and quote route are not certified; no browser or provider interaction was started.";
    }
    return {
      vendor: "sendcutsend",
      status,
      unitPriceUsd: null,
      totalPriceUsd: null,
      leadTimeBusinessDays: null,
      quoteUrl: null,
      dfmIssues: [],
      notes: [note],
      artifacts: [],
      rawPayload: this.payload(input, decision, reason, {
        requiresManualVendorFollowUp: status === "manual_vendor_followup",
        manualFollowUpReason: reason,
      }),
    };
  }

  private payload(
    input: VendorQuoteAdapterInput,
    decision: SendCutSendEnvelopeDecision | null,
    detectedFlow: string,
    extra: Record<string, unknown>,
  ) {
    const source = input.executionContext === "live_evaluation"
      ? "sendcutsend-evaluation-preflight"
      : "sendcutsend-provider-envelope";
    return {
      vendor: "sendcutsend",
      source,
      automationVersion: SENDCUTSEND_AUTOMATION_VERSION,
      executionContext: input.executionContext ?? "production_dispatch",
      envelopeRevision: SENDCUTSEND_CNC_ENVELOPE.revision,
      envelopeDecision: decision,
      accountMode: SENDCUTSEND_CNC_ENVELOPE.accountMode,
      sessionIsolation: "not_started",
      requestedQuantity: input.requestedQuantity,
      detectedFlow,
      orderAttempted: false,
      ...extra,
    };
  }

  private failure(
    input: VendorQuoteAdapterInput,
    code: ConstructorParameters<typeof VendorAutomationError>[1],
    reason: string,
    message: string,
    decision: SendCutSendEnvelopeDecision | null = null,
    extra: Record<string, unknown> = {},
  ) {
    return new VendorAutomationError(
      message,
      code,
      this.payload(input, decision, reason, { reason, ...extra }),
      [],
    );
  }
}
