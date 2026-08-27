import { createHash } from "node:crypto";
import { VendorAdapter } from "./base.js";
import { getAuthorizedLiveEvaluationFiles } from "../liveEvaluationFiles.js";
import { resolveRequirementProcess } from "../partContext.js";
import {
  summarizeWorkerError,
  UNKNOWN_WORKER_ERROR_MESSAGE,
} from "../errorSummary.js";
import {
  type VendorQuoteAdapterInput,
  type VendorQuoteAdapterOffer,
  type VendorQuoteAdapterOutput,
} from "../types.js";
import {
  evaluateSendCutSendCncEnvelope,
  inspectSendCutSendStepGeometry,
  SENDCUTSEND_CNC_ENVELOPE,
  type SendCutSendEnvelopeDecision,
} from "./sendcutsendEnvelope.js";

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
    reason:
      | "duplicate_provider_option_id"
      | "purchasable_offer_incomplete"
      | "purchasable_offer_unparseable"
      | "unapproved_destination";
    providerOptionId: string | null;
  };

export type SendCutSendValidityEvidence = {
  quotedAt: string | null;
  validUntil: string | null;
  validityDurationDays: number | null;
  validitySource: "vendor_date" | "vendor_duration" | null;
  validityTerms: string | null;
};

export type SendCutSendEvaluationSensitivePath = string | null | undefined;

export type SendCutSendEvaluationManifest = {
  schemaVersion: "sendcutsend-evaluation-manifest.v1";
  reviewed: true;
  reviewedAt: string;
  reviewedBy: string;
  envelopeRevision: "sendcutsend-cnc-envelope.v1";
  accountMode: "company_controlled";
  cadFileName: string;
  drawingFileName: string | null;
  cadSha256: string;
  drawingSha256: string | null;
  process: "CNC machining";
  material: "6061-T6 aluminum";
  finish: "as machined";
  tightestToleranceInch: 0.005;
  quantities: number[];
};

const SENDCUTSEND_AUTOMATION_VERSION = "sendcutsend-evaluation-preflight.v1";
const SENDCUTSEND_MANIFEST_KEYS = [
  "accountMode",
  "cadFileName",
  "cadSha256",
  "drawingFileName",
  "drawingSha256",
  "envelopeRevision",
  "finish",
  "material",
  "process",
  "quantities",
  "reviewed",
  "reviewedAt",
  "reviewedBy",
  "schemaVersion",
  "tightestToleranceInch",
] as const;

const PRICE_PATTERN = /(?:\$\s*|\bUSD\s*)(\d+(?:,\d{3})*(?:\.\d{1,2})?)(?![\d.]|,\d)/gi;
const PRICE_CURRENCY_MARKER_PATTERN = /\$|\bUSD\b/gi;
const LEADING_RANGE_AMOUNT_PATTERN = /^[\d,]+(?:\.\d{1,2})?/;
const EXACT_LEAD_TIME_PATTERN = /\b(\d{1,3})\s+(?:business|production|working)\s+days?\b/i;
const LEAD_TIME_RANGE_PATTERN = /\b\d{1,3}\s*(?:-|–|—|\bto\b)\s*\d{1,3}\s+(?:business|production|working)\s+days?\b/i;

const PRICE_BOUND_PREFIXES = [
  "starting at", "starting from", "start at", "start from", "starts at", "starts from",
  "from", "up to",
  "minimum", "minimum price", "minimum cost", "min", "min price", "min cost",
  "maximum", "maximum price", "maximum cost", "max", "max price", "max cost",
  "at least", "at most", "no less than", "no more than", "as low as", "as high as",
  "under", "over",
] as const;
const PRICE_BOUND_SUFFIXES = [
  "or more", "or less", "and up", "and above", "minimum", "maximum", "min", "max",
] as const;

function normalizeAdjacentPriceText(value: string) {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function textAfterRangeSeparator(value: string) {
  const trimmed = value.trimStart();
  for (const separator of ["-", "–", "—"]) {
    if (trimmed.startsWith(separator)) {
      return trimmed.slice(separator.length).trimStart();
    }
  }
  if (trimmed.toLowerCase().startsWith("to")) {
    return trimmed.slice(2).trimStart();
  }
  return null;
}

function withoutOptionalCurrencyPrefix(value: string) {
  let remainder = value;
  if (remainder.toUpperCase().startsWith("USD")) {
    remainder = remainder.slice(3).trimStart();
  }
  if (remainder.startsWith("$")) {
    remainder = remainder.slice(1).trimStart();
  }
  return remainder;
}

function textAfterCurrencyAmount(text: string, marker: RegExpMatchArray) {
  const markerEnd = (marker.index ?? 0) + marker[0].length;
  let remainder = text.slice(markerEnd).trimStart();
  if (marker[0].toUpperCase() === "USD" && remainder.startsWith("$")) {
    remainder = remainder.slice(1).trimStart();
  }
  const amount = LEADING_RANGE_AMOUNT_PATTERN.exec(remainder)?.[0];
  return amount ? remainder.slice(amount.length) : null;
}

function hasPriceRange(text: string) {
  const currencyMarkers = [...text.matchAll(PRICE_CURRENCY_MARKER_PATTERN)];
  return currencyMarkers.some((marker) => {
    const textAfterAmount = textAfterCurrencyAmount(text, marker);
    if (textAfterAmount === null) {
      return false;
    }
    const rangeTail = textAfterRangeSeparator(textAfterAmount);
    if (rangeTail === null) {
      return false;
    }
    return LEADING_RANGE_AMOUNT_PATTERN.test(withoutOptionalCurrencyPrefix(rangeTail));
  });
}

function hasOneSidedPriceBound(text: string, matchIndex: number, matchLength: number) {
  let prefix = normalizeAdjacentPriceText(
    text.slice(Math.max(0, matchIndex - 48), matchIndex),
  ).replace(/:$/, "").trim();
  if (prefix.endsWith(" usd")) {
    prefix = prefix.slice(0, -4).trim();
  }
  const suffix = normalizeAdjacentPriceText(
    text.slice(matchIndex + matchLength, matchIndex + matchLength + 24),
  );
  const hasPrefix = PRICE_BOUND_PREFIXES.some((qualifier) => (
    prefix === qualifier || prefix.endsWith(` ${qualifier}`)
  ));
  const hasSuffix = PRICE_BOUND_SUFFIXES.some((qualifier) => {
    if (!suffix.startsWith(qualifier)) {
      return false;
    }
    const nextCharacter = suffix[qualifier.length];
    return nextCharacter === undefined
      || !"abcdefghijklmnopqrstuvwxyz0123456789_".includes(nextCharacter);
  });
  return hasPrefix || hasSuffix;
}

function isPathStartBoundary(character: string | undefined) {
  return character === undefined || " \n\r\t([{:=<>\"'".includes(character);
}

function pathStartLength(message: string, index: number) {
  if (!isPathStartBoundary(message[index - 1])) {
    return 0;
  }
  if (message[index] === "/" && message[index + 1] !== "/" && message[index + 1] !== " ") {
    return 1;
  }
  if (/[A-Za-z]/.test(message[index] ?? "")
    && message[index + 1] === ":"
    && message[index + 2] === "\\") {
    return 3;
  }
  return 0;
}

function redactGenericEvaluationPaths(message: string) {
  const safePathDelimiters = "\n\r\t;,)]}>\"'";
  let output = "";
  let retainedFrom = 0;
  let index = 0;

  while (index < message.length) {
    const startLength = pathStartLength(message, index);
    if (startLength === 0) {
      index += 1;
      continue;
    }

    let pathEnd = index + startLength;
    while (pathEnd < message.length && !safePathDelimiters.includes(message[pathEnd] ?? "")) {
      pathEnd += 1;
    }
    output += `${message.slice(retainedFrom, index)}<redacted-path>`;
    retainedFrom = pathEnd;
    index = pathEnd;
  }

  return output + message.slice(retainedFrom);
}

function validatedPrices(unitPriceUsd: number, totalPriceUsd: number) {
  const roundedUnitPriceUsd = Math.round(unitPriceUsd * 100) / 100;
  const roundedTotalPriceUsd = Math.round(totalPriceUsd * 100) / 100;
  if (!Number.isFinite(roundedUnitPriceUsd)
    || roundedUnitPriceUsd <= 0
    || !Number.isFinite(roundedTotalPriceUsd)
    || roundedTotalPriceUsd <= 0) {
    return null;
  }
  return {
    unitPriceUsd: roundedUnitPriceUsd,
    totalPriceUsd: roundedTotalPriceUsd,
  };
}

function parsePrice(text: string, quantity: number) {
  if (hasPriceRange(text)) {
    return null;
  }

  const matches = [...text.matchAll(PRICE_PATTERN)];
  const match = matches.length === 1 ? matches[0] : null;
  if (match && hasOneSidedPriceBound(text, match.index ?? 0, match[0].length)) {
    return null;
  }
  const captured = match?.[1] ?? null;
  const price = captured ? Number.parseFloat(captured.replaceAll(",", "")) : Number.NaN;
  if (!Number.isFinite(price) || price <= 0) {
    return null;
  }

  const matchIndex = match?.index ?? 0;
  const context = text.slice(
    Math.max(0, matchIndex - 32),
    matchIndex + (match?.[0].length ?? 0) + 32,
  );
  const safeQuantity = Math.max(1, quantity);
  if (/\b(?:per\s+(?:part|unit)|each)\b/i.test(context)) {
    return validatedPrices(price, price * safeQuantity);
  }
  return validatedPrices(price / safeQuantity, price);
}

function parseLeadTime(text: string) {
  if (LEAD_TIME_RANGE_PATTERN.test(text)) {
    return null;
  }

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

type SendCutSendOfferFailure = Extract<SendCutSendOfferNormalization, { ok: false }>;

type SendCutSendContainerIdentity = {
  providerLabel: string | null;
  providerOptionIdAttribute: string | null;
  providerOptionId: string | null;
};

type SendCutSendContainerAdmission =
  | { kind: "skip" }
  | { kind: "failure"; result: SendCutSendOfferFailure }
  | { kind: "purchasable"; identity: SendCutSendContainerIdentity };

function duplicateProviderFailure(providerOptionId: string): SendCutSendOfferFailure {
  return { ok: false, reason: "duplicate_provider_option_id", providerOptionId };
}

function readContainerIdentity(
  container: SendCutSendQuoteContainer,
): SendCutSendContainerIdentity {
  const providerLabel = container.providerLabel?.replace(/\s+/g, " ").trim() || null;
  const providerOptionIdAttribute = container.providerOptionId?.trim() || null;
  return {
    providerLabel,
    providerOptionIdAttribute,
    providerOptionId: providerOptionIdAttribute || providerLabel,
  };
}

function admitContainer(
  container: SendCutSendQuoteContainer,
  exactMatches: Set<string>,
  availabilityByProviderId: Map<string, SendCutSendQuoteContainer["availability"]>,
): SendCutSendContainerAdmission {
  const fingerprint = containerFingerprint(container);
  if (exactMatches.has(fingerprint)) {
    return { kind: "skip" };
  }
  exactMatches.add(fingerprint);

  const identity = readContainerIdentity(container);
  const providerOptionId = identity.providerOptionId;
  if (providerOptionId) {
    const priorAvailability = availabilityByProviderId.get(providerOptionId);
    if (priorAvailability && priorAvailability !== container.availability) {
      return { kind: "failure", result: duplicateProviderFailure(providerOptionId) };
    }
    availabilityByProviderId.set(providerOptionId, container.availability);
  }
  if (container.availability === "unavailable") {
    return { kind: "skip" };
  }
  return { kind: "purchasable", identity };
}

function normalizePurchasableContainer(
  container: SendCutSendQuoteContainer,
  identity: SendCutSendContainerIdentity,
  requestedQuantity: number,
  sortRank: number,
): { ok: true; offer: VendorQuoteAdapterOffer } | SendCutSendOfferFailure {
  const { providerLabel, providerOptionId, providerOptionIdAttribute } = identity;
  const quoteRef = container.quoteRef?.trim() || null;
  const domMatchId = container.domMatchId.trim();
  const selector = container.selector.trim();
  if (!providerLabel || !providerOptionId || !quoteRef || !domMatchId || !selector) {
    return { ok: false, reason: "purchasable_offer_incomplete", providerOptionId };
  }
  const quoteUrl = approvedDestination(container.quoteUrl);
  if (!quoteUrl) {
    return { ok: false, reason: "unapproved_destination", providerOptionId };
  }
  const price = parsePrice(container.text, requestedQuantity);
  if (!price) {
    return { ok: false, reason: "purchasable_offer_unparseable", providerOptionId };
  }

  const leadTimeBusinessDays = parseLeadTime(container.text);
  const validityEvidence = parseSendCutSendValidityEvidence(container.text);
  return {
    ok: true,
    offer: {
      providerOptionId,
      providerLabel,
      quoteRef,
      quoteUrl,
      ...price,
      leadTimeBusinessDays,
      shipReceiveBy: null,
      tier: providerLabel,
      sourcing: "evaluation_only",
      geographicOrigin: "unknown",
      sortRank,
      provenance: {
        containerSelector: selector,
        providerOptionIdSource: providerOptionIdAttribute ? "attribute" : "provider_label",
        priceSource: "selector",
        leadTimeSource: leadTimeBusinessDays === null ? "none" : "selector",
        geographicOriginSource: "none",
      },
      rawPayload: {
        containerDomMatchId: domMatchId,
        providerText: container.text.replace(/\s+/g, " ").trim().slice(0, 500),
        requestedQuantity,
        validityEvidence,
        evidenceTrust: "evaluation_only_untrusted",
        customerLiveOfferEligible: false,
        persistenceEligible: false,
      },
    },
  };
}

/** Accepts only the exact reviewed HTTPS SendCutSend application origin. */
export function isApprovedSendCutSendOrigin(rawUrl: string) {
  try {
    const url = new URL(rawUrl);
    return url.origin === "https://app.sendcutsend.com"
      && url.username === ""
      && url.password === "";
  } catch {
    return false;
  }
}

function approvedDestination(rawUrl: string | null) {
  if (!rawUrl || !isApprovedSendCutSendOrigin(rawUrl)) {
    return null;
  }
  return new URL(rawUrl).href;
}

function isExactIsoDate(value: string) {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.valueOf())
    && parsed.toISOString().slice(0, 10) === value;
}

/** Retains explicit parseable dates or whole-day validity without inference. */
export function parseSendCutSendValidityEvidence(text: string): SendCutSendValidityEvidence {
  const quotedDate = /\bquoted\s+(?:at|on)\s+(\d{4}-\d{2}-\d{2})\b/i.exec(text)?.[1] ?? null;
  const validUntilMatch = /\bvalid\s+(?:until|through)\s+(\d{4}-\d{2}-\d{2})\b/i.exec(text);
  const durationMatch = /\bvalid\s+for\s+(\d{1,3})\s+days?\b/i.exec(text);
  const quotedAt = quotedDate && isExactIsoDate(quotedDate) ? quotedDate : null;
  const validUntilDate = validUntilMatch?.[1] ?? null;
  const validUntil = validUntilDate && isExactIsoDate(validUntilDate)
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

/** Normalizes a complete local fixture set without certifying it for persistence. */
export function normalizeSendCutSendOffers(
  containers: SendCutSendQuoteContainer[],
  requestedQuantity: number,
): SendCutSendOfferNormalization {
  if (!Number.isSafeInteger(requestedQuantity) || requestedQuantity <= 0) {
    return {
      ok: false,
      reason: "purchasable_offer_unparseable",
      providerOptionId: null,
    };
  }
  const exactMatches = new Set<string>();
  const availabilityByProviderId = new Map<string, SendCutSendQuoteContainer["availability"]>();
  const providerIds = new Set<string>();
  const offers: VendorQuoteAdapterOffer[] = [];

  for (const container of containers) {
    const admission = admitContainer(container, exactMatches, availabilityByProviderId);
    if (admission.kind === "skip") {
      continue;
    }
    if (admission.kind === "failure") {
      return admission.result;
    }

    const normalized = normalizePurchasableContainer(
      container,
      admission.identity,
      requestedQuantity,
      offers.length,
    );
    if (!normalized.ok) {
      return normalized;
    }
    const providerOptionId = normalized.offer.providerOptionId;
    if (providerIds.has(providerOptionId)) {
      return duplicateProviderFailure(providerOptionId);
    }

    providerIds.add(providerOptionId);
    offers.push(normalized.offer);
  }

  return { ok: true, offers };
}

function readErrorMessage(error: unknown) {
  if (typeof error === "string") {
    return error;
  }
  if (error && typeof error === "object" && !Array.isArray(error)) {
    try {
      const message = (error as { message?: unknown }).message;
      return typeof message === "string" ? message : UNKNOWN_WORKER_ERROR_MESSAGE;
    } catch {
      return UNKNOWN_WORKER_ERROR_MESSAGE;
    }
  }
  return UNKNOWN_WORKER_ERROR_MESSAGE;
}

/** Redacts supplied and arbitrary filesystem paths before the final 1,000-character bound. */
export function safeSendCutSendEvaluationError(
  error: unknown,
  sensitivePaths: readonly SendCutSendEvaluationSensitivePath[] = [],
) {
  let message = readErrorMessage(error);
  const exactPaths = sensitivePaths
    .filter((entry): entry is string => typeof entry === "string" && entry.length > 1)
    .sort((left, right) => right.length - left.length);
  for (const exactPath of exactPaths) {
    message = message.replaceAll(exactPath, "<redacted-path>");
  }
  return summarizeWorkerError(redactGenericEvaluationPaths(message));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactManifestKeys(value: Record<string, unknown>) {
  const actual = Object.keys(value).sort((left, right) => left.localeCompare(right));
  const expected = [...SENDCUTSEND_MANIFEST_KEYS]
    .sort((left, right) => left.localeCompare(right));
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function isExactManifestFileName(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.trim() === value
    && !value.includes("/")
    && !value.includes("\\");
}

/** Parses only the complete, exact, versioned SendCutSend evaluation manifest. */
export function parseSendCutSendEvaluationManifest(
  value: unknown,
): SendCutSendEvaluationManifest | null {
  if (!isRecord(value) || !hasExactManifestKeys(value)) {
    return null;
  }
  const drawingFileNameValid = value.drawingFileName === null
    || isExactManifestFileName(value.drawingFileName);
  const drawingShaValid = value.drawingSha256 === null
    || (typeof value.drawingSha256 === "string"
      && /^[a-f0-9]{64}$/.test(value.drawingSha256));
  const drawingPresenceMatches = (value.drawingFileName === null)
    === (value.drawingSha256 === null);
  const quantities = value.quantities;
  const exactFacts = value.schemaVersion === "sendcutsend-evaluation-manifest.v1"
    && value.reviewed === true
    && typeof value.reviewedAt === "string"
    && isExactIsoDate(value.reviewedAt)
    && typeof value.reviewedBy === "string"
    && value.reviewedBy.length > 0
    && value.reviewedBy.trim() === value.reviewedBy
    && value.envelopeRevision === SENDCUTSEND_CNC_ENVELOPE.revision
    && value.accountMode === SENDCUTSEND_CNC_ENVELOPE.accountMode
    && value.process === "CNC machining"
    && value.material === SENDCUTSEND_CNC_ENVELOPE.material
    && value.finish === "as machined"
    && value.tightestToleranceInch === SENDCUTSEND_CNC_ENVELOPE.standardToleranceInch
    && isExactManifestFileName(value.cadFileName)
    && drawingFileNameValid
    && typeof value.cadSha256 === "string"
    && /^[a-f0-9]{64}$/.test(value.cadSha256)
    && drawingShaValid
    && drawingPresenceMatches
    && Array.isArray(quantities)
    && quantities.length > 0
    && quantities.every(
      (quantity) => Number.isSafeInteger(quantity) && Number(quantity) > 0,
    )
    && new Set(quantities).size === quantities.length;
  return exactFacts ? value as SendCutSendEvaluationManifest : null;
}

function readSendCutSendEvaluationManifest(
  input: VendorQuoteAdapterInput,
): SendCutSendEvaluationManifest | null {
  const snapshot = input.requirement.spec_snapshot;
  return isRecord(snapshot)
    ? parseSendCutSendEvaluationManifest(snapshot.evaluationManifest)
    : null;
}

function manifestMatchesAuthorizedInput(
  manifest: SendCutSendEvaluationManifest,
  input: VendorQuoteAdapterInput,
  files: NonNullable<ReturnType<typeof getAuthorizedLiveEvaluationFiles>>,
) {
  const authorization = input.liveEvaluationAuthorization;
  const capturedCadSha256 = createHash("sha256").update(files.cad.buffer).digest("hex");
  const capturedDrawingSha256 = files.drawing
    ? createHash("sha256").update(files.drawing.buffer).digest("hex")
    : null;
  return authorization?.nonExportControlled === true
    && manifest.cadFileName === files.cad.name
    && manifest.drawingFileName === (files.drawing?.name ?? null)
    && manifest.cadSha256 === authorization.cadFileSha256
    && manifest.drawingSha256 === authorization.drawingFileSha256
    && manifest.cadSha256 === capturedCadSha256
    && manifest.drawingSha256 === capturedDrawingSha256
    && manifest.quantities.includes(input.requestedQuantity)
    && resolveRequirementProcess(input.requirement.spec_snapshot) === manifest.process
    && input.requirement.material === manifest.material
    && input.requirement.finish === manifest.finish
    && input.requirement.tightest_tolerance_inch === manifest.tightestToleranceInch;
}

export class SendCutSendAdapter extends VendorAdapter {
  async quote(input: VendorQuoteAdapterInput): Promise<VendorQuoteAdapterOutput> {
    if (this.config.workerMode !== "live") {
      return this.emptyResult(input, null, "live_evaluation_not_enabled");
    }
    if (input.executionContext !== "live_evaluation") {
      return this.emptyResult(input, null, "provider_neutral_authorization_unavailable");
    }

    const files = getAuthorizedLiveEvaluationFiles(input);
    if (!files) {
      return this.emptyResult(input, null, "evaluation_file_authorization_unavailable");
    }
    const manifest = readSendCutSendEvaluationManifest(input);
    if (!manifest) {
      return this.emptyResult(input, null, "evaluation_manifest_invalid");
    }
    if (!manifestMatchesAuthorizedInput(manifest, input, files)) {
      return this.emptyResult(input, null, "evaluation_manifest_binding_mismatch");
    }

    try {
      const decision = evaluateSendCutSendCncEnvelope({
        fileName: files.cad.name,
        process: resolveRequirementProcess(input.requirement.spec_snapshot),
        material: input.requirement.material,
        finish: input.requirement.finish,
        tightestToleranceInch: input.requirement.tightest_tolerance_inch,
        quantity: input.requestedQuantity,
        drawingIncluded: files.drawing !== null,
        accountMode: manifest.accountMode,
        geometry: inspectSendCutSendStepGeometry({
          fileName: files.cad.name,
          buffer: files.cad.buffer,
        }),
      });
      if (!decision.eligible) {
        return this.emptyResult(input, decision, "outside_certified_cnc_envelope");
      }
      return this.emptyResult(
        input,
        decision,
        "provider_configuration_contract_uncertified",
      );
    } catch (error) {
      return this.emptyResult(input, null, "evaluation_preflight_failed", error);
    }
  }

  private emptyResult(
    input: VendorQuoteAdapterInput,
    decision: SendCutSendEnvelopeDecision | null,
    reason: string,
    error?: unknown,
  ): VendorQuoteAdapterOutput {
    const sensitivePaths = [
      input.stagedCadFile?.localPath,
      input.stagedDrawingFile?.localPath,
    ];
    const safeError = error === undefined
      ? null
      : safeSendCutSendEvaluationError(error, sensitivePaths);
    return {
      vendor: "sendcutsend",
      status: "manual_vendor_followup",
      unitPriceUsd: null,
      totalPriceUsd: null,
      leadTimeBusinessDays: null,
      quoteUrl: null,
      offers: [],
      dfmIssues: [],
      notes: [this.noteFor(reason)],
      artifacts: [],
      rawPayload: {
        vendor: "sendcutsend",
        source: input.executionContext === "live_evaluation"
          ? "sendcutsend-evaluation-preflight"
          : "sendcutsend-provider-envelope",
        automationVersion: SENDCUTSEND_AUTOMATION_VERSION,
        executionContext: input.executionContext ?? "production_dispatch",
        envelopeRevision: SENDCUTSEND_CNC_ENVELOPE.revision,
        envelopeDecision: decision,
        accountMode: SENDCUTSEND_CNC_ENVELOPE.accountMode,
        sessionIsolation: "not_started",
        detectedFlow: reason,
        requestedQuantity: input.requestedQuantity,
        requiresManualVendorFollowUp: true,
        manualFollowUpReason: reason,
        evidenceTrust: "evaluation_only_untrusted",
        customerLiveOfferEligible: false,
        persistenceEligible: false,
        providerInteractionAttempted: false,
        disclosureAttempted: false,
        configurationAttempted: false,
        quoteAcquisitionAttempted: false,
        orderAttempted: false,
        ...(safeError ? { error: safeError } : {}),
      },
    };
  }

  private noteFor(reason: string) {
    if (reason === "outside_certified_cnc_envelope") {
      return "The package is outside the reviewed SendCutSend CNC envelope and was not disclosed.";
    }
    if (reason === "provider_configuration_contract_uncertified") {
      return "Provider configuration and quote acquisition are not certified; no provider interaction was started.";
    }
    return "SendCutSend evaluation stopped before provider interaction and requires manual follow-up.";
  }
}
