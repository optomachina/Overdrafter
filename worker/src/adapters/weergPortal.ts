import type { VendorQuoteAdapterInput, WorkerConfig } from "../types.js";
import {
  classifyProviderPortalSnapshot,
  runProviderPortalKernel,
  type ProviderPortalDefinition,
  type ProviderPortalEligibility,
} from "./providerPortalKernel.js";
import { evaluateWeergEnvelope, WEERG_ENVELOPE_REVISION, type WeergEnvelopeInput } from "./weergEnvelope.js";

export const WEERG_ADAPTER_REVISION = "weerg-offline-preflight.v1" as const;

/** Binds reviewed envelope facts to the actual evaluation package without inferring unknown facts. */
export function assessWeergEvaluationPackage(
  input: VendorQuoteAdapterInput,
  facts: WeergEnvelopeInput,
): ProviderPortalEligibility {
  if (facts.quantity !== input.requestedQuantity
    || facts.fileName !== input.stagedCadFile?.originalName
    || facts.material !== input.requirement.material
    || facts.drawingIncluded !== Boolean(input.stagedDrawingFile)) {
    return { state: "unsupported", reason: "weerg_envelope_package_mismatch" };
  }
  const decision = evaluateWeergEnvelope(facts);
  if (decision.state !== "eligible_for_evaluation") {
    return {
      state: "unsupported",
      reason: `weerg_envelope_${decision.state}:${decision.reasonCodes.join(",")}`,
    };
  }
  return { state: "unavailable", reason: "weerg_reviewed_portal_binding_missing" };
}

/**
 * Inert local preflight definition. Public homepage URLs are placeholders, not
 * observed login/upload routes. No selector or portal readiness is claimed.
 * The eligibility hook always terminates before session resolution or launch.
 */
export function createWeergPortalDefinition(facts: WeergEnvelopeInput): ProviderPortalDefinition {
  const reviewedFacts = structuredClone(facts);
  return {
    provider: "weerg",
    displayName: "Weerg",
    manifestRevision: "weerg-manifest.v1",
    envelopeRevision: WEERG_ENVELOPE_REVISION,
    adapterRevision: WEERG_ADAPTER_REVISION,
    accountMode: "existing_authenticated_account",
    routes: {
      publicUrl: "https://www.weerg.com/",
      loginUrl: "https://www.weerg.com/",
      uploadUrl: "https://www.weerg.com/",
    },
    allowedHosts: ["www.weerg.com"],
    selectors: { cadUpload: ":not(*)" },
    supportedFileExtensions: ["step", "stp"],
    terminalSignals: {
      login: [/\b(?:login|sign in|session expired)\b/i],
      captcha: [/\b(?:captcha|verify you are human)\b/i],
      manualReview: [/\b(?:manual review|engineering review)\b/i],
      configurationRequired: [/\b(?:select material|configure part)\b/i],
      unavailable: [/\b(?:unavailable|maintenance)\b/i],
    },
    requirements: { quoteOnly: true, orderProhibited: true, isolatedSession: true },
    hooks: {
      assessEligibility: (input) => assessWeergEvaluationPackage(input, reviewedFacts),
      configure: () => undefined,
      classifyPortalState: (snapshot) => {
        const state = classifyProviderPortalSnapshot(snapshot);
        if (/\bsession expired\b/i.test(snapshot.bodyText)) return "login_required";
        return state === "ready" ? "selector_drift" : state;
      },
      extractOffers: () => [],
    },
  };
}

/** Performs exact-file kernel preflight only; never produces offers or provider traffic. */
export function runWeergLocalEvaluationPreflight(
  config: WorkerConfig,
  input: VendorQuoteAdapterInput,
  facts: WeergEnvelopeInput,
) {
  return runProviderPortalKernel(createWeergPortalDefinition(facts), config, input);
}
