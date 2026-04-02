const CANONICAL_SERVICE_TYPE_OPTIONS = [
  {
    code: "manufacturing_quote",
    label: "Manufacturing quote",
    description: "Collect vendor pricing or curated quote options for a manufacturable part.",
    quoteCompatible: true,
  },
  {
    code: "cad_modeling",
    label: "CAD modeling",
    description: "Create or remodel a usable 3D part model from incomplete design inputs.",
    quoteCompatible: false,
  },
  {
    code: "drawing_redraft",
    label: "Drawing redraft",
    description: "Create, clean up, or reissue a manufacturing drawing or release package.",
    quoteCompatible: false,
  },
  {
    code: "fea_analysis",
    label: "FEA analysis",
    description: "Produce an engineering analysis result tied to the design package.",
    quoteCompatible: false,
  },
  {
    code: "dfm_review",
    label: "DFM review",
    description: "Review manufacturability risks and recommend design changes.",
    quoteCompatible: false,
  },
  {
    code: "dfa_review",
    label: "DFA review",
    description: "Review assembly-focused risks and recommend design or process changes.",
    quoteCompatible: false,
  },
  {
    code: "assembly_support",
    label: "Assembly support",
    description: "Coordinate multi-part BOM, fit, sequence, or assembly package support.",
    quoteCompatible: false,
  },
  {
    code: "sourcing_only",
    label: "Sourcing only",
    description: "Obtain supplier options without implying a full engineering deliverable.",
    quoteCompatible: true,
  },
] as const;

export type RequestedServiceKind = (typeof CANONICAL_SERVICE_TYPE_OPTIONS)[number]["code"];

export type RequestedServiceIntent = {
  requestedServiceKinds: string[];
  primaryServiceKind: string | null;
  serviceNotes: string | null;
};

export const REQUESTED_SERVICE_TYPE_OPTIONS = CANONICAL_SERVICE_TYPE_OPTIONS;

export const DEFAULT_REQUESTED_SERVICE_KIND: RequestedServiceKind = "manufacturing_quote";

const VALID_REQUESTED_SERVICE_KINDS = new Set<RequestedServiceKind>(
  REQUESTED_SERVICE_TYPE_OPTIONS.map((option) => option.code),
);

const QUOTE_COMPATIBLE_SERVICE_KINDS = new Set<RequestedServiceKind>(
  REQUESTED_SERVICE_TYPE_OPTIONS.filter((option) => option.quoteCompatible).map((option) => option.code),
);

export function isRequestedServiceKind(value: string): value is RequestedServiceKind {
  return VALID_REQUESTED_SERVICE_KINDS.has(value as RequestedServiceKind);
}

export function normalizeRequestedServiceKinds(
  values: readonly string[] | null | undefined,
  fallbackPrimaryServiceKind?: string | null,
): RequestedServiceKind[] {
  const normalized: RequestedServiceKind[] = [];
  const seen = new Set<RequestedServiceKind>();

  values?.forEach((value) => {
    if (!isRequestedServiceKind(value) || seen.has(value)) {
      return;
    }

    seen.add(value);
    normalized.push(value);
  });

  if (normalized.length > 0) {
    return normalized;
  }

  if (fallbackPrimaryServiceKind && isRequestedServiceKind(fallbackPrimaryServiceKind)) {
    return [fallbackPrimaryServiceKind];
  }

  return [DEFAULT_REQUESTED_SERVICE_KIND];
}

export function normalizePrimaryServiceKind(
  requestedServiceKinds: readonly string[] | null | undefined,
  primaryServiceKind: string | null | undefined,
): RequestedServiceKind {
  const normalizedKinds = normalizeRequestedServiceKinds(requestedServiceKinds, primaryServiceKind);

  if (primaryServiceKind && normalizedKinds.includes(primaryServiceKind as RequestedServiceKind)) {
    return primaryServiceKind as RequestedServiceKind;
  }

  return normalizedKinds[0] ?? DEFAULT_REQUESTED_SERVICE_KIND;
}

export function normalizeRequestedServiceIntent(
  input: Partial<RequestedServiceIntent> | null | undefined,
): RequestedServiceIntent {
  const requestedServiceKinds = normalizeRequestedServiceKinds(
    input?.requestedServiceKinds,
    input?.primaryServiceKind,
  );
  const primaryServiceKind = normalizePrimaryServiceKind(
    requestedServiceKinds,
    input?.primaryServiceKind ?? null,
  );
  const serviceNotes = input?.serviceNotes?.trim() ? input.serviceNotes.trim() : null;

  return {
    requestedServiceKinds,
    primaryServiceKind,
    serviceNotes,
  };
}

export function isQuoteCompatibleServiceKind(serviceKind: RequestedServiceKind): boolean {
  return QUOTE_COMPATIBLE_SERVICE_KINDS.has(serviceKind);
}

export function requestedServicesSupportQuoteFields(
  requestedServiceKinds: readonly string[] | null | undefined,
): boolean {
  const normalizedServiceKinds = normalizeRequestedServiceKinds(requestedServiceKinds);
  return (
    normalizedServiceKinds.length > 0 &&
    normalizedServiceKinds.every((serviceKind) => isQuoteCompatibleServiceKind(serviceKind))
  );
}

export function requestedServicesRequireMaterial(
  requestedServiceKinds: readonly string[] | null | undefined,
): boolean {
  return normalizeRequestedServiceKinds(requestedServiceKinds).includes("manufacturing_quote");
}

export function formatRequestedServiceKindLabel(serviceKind: string | null | undefined): string {
  const option = REQUESTED_SERVICE_TYPE_OPTIONS.find((candidate) => candidate.code === serviceKind);
  return option?.label ?? "Manufacturing quote";
}
