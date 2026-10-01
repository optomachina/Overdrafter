import { z } from "zod";
import type { VendorAdapter } from "./base.js";
import type { ExtractedValue, ValueSource } from "../extractedValue.js";
import type {
  GeographicOrigin,
  VendorArtifact,
  VendorName,
  VendorQuoteAdapterInput,
  VendorQuoteAdapterOutput,
} from "../types.js";

export const LOCAL_NATIVE_CURRENCY_CONTRACT_REVISION = "local-native-currency-evidence.v1" as const;
export type LocalEvidenceCurrency = "USD" | "EUR";
type SelectorProvenance = { source: "selector"; selector: string };

/** Local evidence only. Deliberately has neither USD prices nor a raw payload. */
export type LocalNativeCurrencyOffer = {
  providerOptionId: string;
  providerLabel: string;
  quantity: number;
  money: {
    currency: LocalEvidenceCurrency;
    unitAmount: number;
    totalAmount: number;
    provenance: {
      unitAmount: SelectorProvenance;
      totalAmount: SelectorProvenance;
      unitCurrency: SelectorProvenance;
      totalCurrency: SelectorProvenance;
    };
  };
  leadTimeBusinessDays: number | null;
  shipReceiveBy: string | null;
  tier: string | null;
  sourcing: string | null;
  geographicOrigin: GeographicOrigin;
  provenance: {
    containerSelector: string;
    providerOptionIdSource: "attribute" | "provider_label";
    leadTimeSource: ValueSource;
    geographicOriginSource: "provider_text" | "none";
  };
  validUntil: string | null;
  validityDurationDays: number | null;
  validitySource: "vendor_date" | "vendor_duration" | null;
  validityTerms: string | null;
  artifactRefs: string[];
};

export type LocalNativeCurrencyEvaluationResult = {
  kind: "local_native_currency_evaluation";
  contractRevision: typeof LOCAL_NATIVE_CURRENCY_CONTRACT_REVISION;
  executionContext: "live_evaluation";
  localOnly: true;
  customerOfferPersistence: false;
  providerAdmission: false;
  providerMutationPossible: boolean;
  vendor: VendorName;
  status: "native_offers_extracted";
  nativeOffers: LocalNativeCurrencyOffer[];
  artifacts: VendorArtifact[];
  manifestRevision: string;
  envelopeRevision: string;
  adapterRevision: string;
};

export type LocalEvaluationResult = VendorQuoteAdapterOutput | LocalNativeCurrencyEvaluationResult;
export type LocalEvaluationAdapter = VendorAdapter & {
  evaluateLocally?(input: VendorQuoteAdapterInput): Promise<LocalEvaluationResult>;
};

export function isLocalNativeCurrencyResult(result: LocalEvaluationResult): result is LocalNativeCurrencyEvaluationResult {
  return "kind" in result && result.kind === "local_native_currency_evaluation";
}

export function isSupportedLocalCurrency(value: unknown): value is LocalEvidenceCurrency {
  return value === "USD" || value === "EUR";
}

export function isSelectorAnchored<T>(value: ExtractedValue<T>): value is ExtractedValue<T> & SelectorProvenance & { value: T } {
  return value?.value !== null && value?.value !== undefined
    && value.source === "selector" && typeof value.selector === "string" && value.selector.trim().length > 0;
}

const textSchema = z.string().min(1).max(1_000);
const selectorSchema = textSchema.refine((value) => value.trim().length > 0);
const selectorProvenanceSchema = z.object({
  source: z.literal("selector"),
  selector: selectorSchema,
}).strict();
const positiveNumberSchema = z.number().finite().positive();
const dateSchema = z.string().max(40).refine((value) => {
  // ISO dates/timestamps are structured evidence, never locale-parsed prose.
  if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value)) {
    return false;
  }
  const day = value.slice(0, 10);
  const parsedDay = new Date(`${day}T00:00:00Z`);
  return Number.isFinite(parsedDay.getTime()) && parsedDay.toISOString().slice(0, 10) === day
    && Number.isFinite(Date.parse(value));
});

const nativeOfferShape = z.object({
  providerOptionId: textSchema.refine((value) => value === value.trim()),
  providerLabel: textSchema,
  quantity: z.number().int().positive().safe(),
  money: z.object({
    currency: z.enum(["USD", "EUR"]),
    unitAmount: positiveNumberSchema,
    totalAmount: positiveNumberSchema,
    provenance: z.object({
      unitAmount: selectorProvenanceSchema,
      totalAmount: selectorProvenanceSchema,
      unitCurrency: selectorProvenanceSchema,
      totalCurrency: selectorProvenanceSchema,
    }).strict(),
  }).strict(),
  leadTimeBusinessDays: positiveNumberSchema.nullable(),
  shipReceiveBy: dateSchema.nullable(),
  tier: textSchema.nullable(),
  sourcing: textSchema.nullable(),
  geographicOrigin: z.enum(["domestic", "foreign", "unknown"]),
  provenance: z.object({
    containerSelector: selectorSchema,
    providerOptionIdSource: z.enum(["attribute", "provider_label"]),
    leadTimeSource: z.enum(["selector", "body_text", "none"]),
    geographicOriginSource: z.enum(["provider_text", "none"]),
  }).strict(),
  validUntil: dateSchema.nullable(),
  validityDurationDays: z.number().int().positive().safe().nullable(),
  validitySource: z.enum(["vendor_date", "vendor_duration"]).nullable(),
  validityTerms: textSchema.nullable(),
  artifactRefs: z.array(textSchema).max(500),
}).strict();

function consistentCommercialFacts(offer: LocalNativeCurrencyOffer): boolean {
  if (offer.leadTimeBusinessDays !== null && offer.provenance.leadTimeSource !== "selector") {
    return false;
  }
  const expectedGeographySource = offer.geographicOrigin === "unknown" ? "none" : "provider_text";
  if (offer.provenance.geographicOriginSource !== expectedGeographySource) {
    return false;
  }
  switch (offer.validitySource) {
    case "vendor_date": return offer.validUntil !== null;
    case "vendor_duration": return offer.validityDurationDays !== null;
    case null: return offer.validUntil === null && offer.validityDurationDays === null;
  }
}

const nativeOfferSchema = nativeOfferShape.refine(consistentCommercialFacts);

/** Closed runtime validation also covers fields other than money and their sources. */
export function parseLocalNativeCurrencyOffer(value: unknown): LocalNativeCurrencyOffer | null {
  const parsed = nativeOfferSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

const nativeResultSchema = z.object({
  kind: z.literal("local_native_currency_evaluation"),
  contractRevision: z.literal(LOCAL_NATIVE_CURRENCY_CONTRACT_REVISION),
  executionContext: z.literal("live_evaluation"),
  localOnly: z.literal(true),
  customerOfferPersistence: z.literal(false),
  providerAdmission: z.literal(false),
  providerMutationPossible: z.boolean(),
  vendor: textSchema,
  status: z.literal("native_offers_extracted"),
  nativeOffers: z.array(nativeOfferSchema).min(1).max(1_000),
  artifacts: z.array(z.object({
    kind: z.enum(["screenshot", "html_snapshot", "trace", "json"]),
    label: textSchema,
    localPath: z.string().min(1).max(4_096),
    contentType: z.string().max(128).regex(/^[a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+$/),
  }).strict()).max(500),
  manifestRevision: textSchema,
  envelopeRevision: textSchema,
  adapterRevision: textSchema,
}).strict();

/** Recheck and copy the closed local contract at serialization, without USD coercion. */
export function assertLocalNativeCurrencyResult(
  result: LocalNativeCurrencyEvaluationResult,
  input: VendorQuoteAdapterInput,
  vendor: VendorName,
): LocalNativeCurrencyEvaluationResult {
  const parsed = nativeResultSchema.safeParse(result);
  if (input.executionContext !== "live_evaluation" || !parsed.success || parsed.data.vendor !== vendor) {
    throw new Error("Local native-currency evidence contract failed.");
  }
  const offers = parsed.data.nativeOffers;
  if (offers.some((offer) => offer.quantity !== input.requestedQuantity)
    || new Set(offers.map((offer) => offer.providerOptionId)).size !== offers.length
    || new Set(offers.map((offer) => offer.money.currency)).size !== 1) {
    throw new Error("Local native-currency evidence contract failed.");
  }
  return { ...parsed.data, vendor };
}
