import {
  DEFAULT_REQUESTED_SERVICE_KIND,
  isQuoteCompatibleServiceKind,
  normalizePrimaryServiceKind,
  normalizeRequestedServiceIntent,
  normalizeRequestedServiceKinds,
  type RequestedServiceKind,
  type RequestedServiceIntent,
} from "@/features/quotes/service-intent";
import { normalizeRequestedQuoteQuantities } from "@/features/quotes/request-intake";
import type {
  ServiceRequestLineItem,
  ServiceRequestLineItemInput,
  ServiceRequestLineItemRecord,
} from "@/features/quotes/types";
import type { Json, ServiceRequestScope } from "@/integrations/supabase/types";

const DEFAULT_SCOPE: ServiceRequestScope = "job";

type WorkpackDefaults = {
  requestedServiceKinds?: readonly string[] | null;
  primaryServiceKind?: string | null;
  serviceNotes?: string | null;
  requestedByDate?: string | null;
  requestedQuoteQuantities?: readonly number[] | null;
  scope?: ServiceRequestScope;
};

type QuoteCompatiblePayload = {
  requestedQuoteQuantities?: number[];
};

function asObject(value: Json | null | undefined): Record<string, Json | undefined> {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    return {};
  }

  return value as Record<string, Json | undefined>;
}

function normalizeScope(value: string | null | undefined): ServiceRequestScope {
  return value === "project" || value === "part" ? value : DEFAULT_SCOPE;
}

function normalizeQuoteCompatiblePayload(
  serviceType: string,
  detailPayload: Json | null | undefined,
  fallbackRequestedQuoteQuantities: readonly number[] | null | undefined,
): Json {
  if (!isQuoteCompatibleServiceKind(serviceType as RequestedServiceKind)) {
    return {};
  }

  const payload = asObject(detailPayload);
  const requestedQuoteQuantities = normalizeRequestedQuoteQuantities(
    Array.isArray(payload.requestedQuoteQuantities)
      ? payload.requestedQuoteQuantities.filter((value): value is number => Number.isFinite(value))
      : fallbackRequestedQuoteQuantities ?? [],
  );

  return {
    requestedQuoteQuantities,
  } satisfies QuoteCompatiblePayload;
}

export function mapServiceRequestRecord(
  record: ServiceRequestLineItemRecord,
): ServiceRequestLineItem {
  return {
    id: record.id,
    organizationId: record.organization_id,
    projectId: record.project_id,
    jobId: record.job_id,
    partId: record.part_id,
    serviceType: record.service_type,
    scope: record.scope,
    requestedByDate: record.requested_by_date,
    serviceNotes: record.service_notes,
    detailPayload: record.detail_payload,
    displayOrder: record.display_order,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };
}

export function normalizeServiceRequestInputs(
  items: readonly ServiceRequestLineItemInput[] | null | undefined,
  defaults: WorkpackDefaults = {},
): ServiceRequestLineItemInput[] {
  const fallbackIntent = normalizeRequestedServiceIntent({
    requestedServiceKinds: defaults.requestedServiceKinds ? [...defaults.requestedServiceKinds] : undefined,
    primaryServiceKind: defaults.primaryServiceKind,
    serviceNotes: defaults.serviceNotes,
  });
  const seen = new Set<string>();
  const normalized = (items ?? [])
    .map((item, index) => {
      const serviceType = normalizeRequestedServiceKinds(
        item.serviceType ? [item.serviceType] : [],
        fallbackIntent.primaryServiceKind,
      )[0];

      if (seen.has(serviceType)) {
        return null;
      }

      seen.add(serviceType);

      return {
        id: item.id,
        serviceType,
        scope: normalizeScope(item.scope),
        requestedByDate: item.requestedByDate ?? defaults.requestedByDate ?? null,
        serviceNotes: item.serviceNotes?.trim() || defaults.serviceNotes || null,
        detailPayload: normalizeQuoteCompatiblePayload(
          serviceType,
          item.detailPayload,
          defaults.requestedQuoteQuantities,
        ),
        displayOrder: item.displayOrder ?? index,
      } satisfies ServiceRequestLineItemInput;
    })
    .filter((item): item is NonNullable<typeof item> => item !== null)
    .sort((left, right) => (left.displayOrder ?? 0) - (right.displayOrder ?? 0));

  if (normalized.length > 0) {
    return normalized.map((item, index) => ({
      ...item,
      displayOrder: index,
    }));
  }

  return buildServiceRequestInputsFromIntent(defaults);
}

export function syncPrimaryQuoteServiceRequestWithCompatibilityFields(
  items: readonly ServiceRequestLineItemInput[] | null | undefined,
  defaults: WorkpackDefaults = {},
): ServiceRequestLineItemInput[] {
  const normalizedItems = normalizeServiceRequestInputs(items, defaults);
  const primaryQuoteServiceRequestIndex = normalizedItems.findIndex((item) =>
    isQuoteCompatibleServiceKind(item.serviceType as RequestedServiceKind),
  );

  if (primaryQuoteServiceRequestIndex === -1) {
    return normalizedItems;
  }

  const primaryQuoteServiceRequest = normalizedItems[primaryQuoteServiceRequestIndex];
  const requestedQuoteQuantities =
    defaults.requestedQuoteQuantities !== undefined
      ? normalizeRequestedQuoteQuantities(defaults.requestedQuoteQuantities)
      : readServiceRequestQuoteQuantities(primaryQuoteServiceRequest.detailPayload);
  const requestedByDate =
    defaults.requestedByDate !== undefined
      ? defaults.requestedByDate ?? null
      : primaryQuoteServiceRequest.requestedByDate ?? null;

  return normalizedItems.map((item, index) =>
    index === primaryQuoteServiceRequestIndex
      ? {
          ...item,
          requestedByDate,
          detailPayload: normalizeQuoteCompatiblePayload(
            item.serviceType,
            {
              requestedQuoteQuantities,
            },
            requestedQuoteQuantities,
          ),
        }
      : item,
  );
}

export function buildServiceRequestInputsFromIntent(
  defaults: WorkpackDefaults = {},
): ServiceRequestLineItemInput[] {
  const intent = normalizeRequestedServiceIntent({
    requestedServiceKinds: defaults.requestedServiceKinds ? [...defaults.requestedServiceKinds] : undefined,
    primaryServiceKind: defaults.primaryServiceKind,
    serviceNotes: defaults.serviceNotes,
  });

  return intent.requestedServiceKinds.map((serviceType, index) => ({
    serviceType,
    scope: defaults.scope ?? DEFAULT_SCOPE,
    requestedByDate: defaults.requestedByDate ?? null,
    serviceNotes: defaults.serviceNotes ?? null,
    detailPayload: normalizeQuoteCompatiblePayload(
      serviceType,
      {},
      defaults.requestedQuoteQuantities,
    ),
    displayOrder: index,
  }));
}

export function buildRequestedServiceIntentFromServiceRequests(
  items: readonly Pick<ServiceRequestLineItemInput, "serviceType" | "serviceNotes" | "displayOrder">[] | null | undefined,
  fallback: RequestedServiceIntent = {
    requestedServiceKinds: [DEFAULT_REQUESTED_SERVICE_KIND],
    primaryServiceKind: DEFAULT_REQUESTED_SERVICE_KIND,
    serviceNotes: null,
  },
): RequestedServiceIntent {
  const sorted = [...(items ?? [])].sort(
    (left, right) => (left.displayOrder ?? 0) - (right.displayOrder ?? 0),
  );
  const requestedServiceKinds = normalizeRequestedServiceKinds(
    sorted.map((item) => item.serviceType),
    fallback.primaryServiceKind,
  );
  const sharedServiceNotes =
    sorted.length > 0 &&
    sorted.every((item) => (item.serviceNotes?.trim() || null) === (sorted[0]?.serviceNotes?.trim() || null))
      ? sorted[0]?.serviceNotes?.trim() || null
      : fallback.serviceNotes ?? null;

  return {
    requestedServiceKinds,
    primaryServiceKind: normalizePrimaryServiceKind(
      requestedServiceKinds,
      requestedServiceKinds[0] ?? fallback.primaryServiceKind,
    ),
    serviceNotes: sharedServiceNotes,
  };
}

export function getPrimaryServiceRequest(
  items: readonly Pick<ServiceRequestLineItemInput, "serviceType" | "displayOrder">[] | null | undefined,
): string {
  const sorted = [...(items ?? [])].sort(
    (left, right) => (left.displayOrder ?? 0) - (right.displayOrder ?? 0),
  );

  return sorted[0]?.serviceType ?? DEFAULT_REQUESTED_SERVICE_KIND;
}

export function getPrimaryQuoteServiceRequest(
  items: readonly Pick<ServiceRequestLineItemInput, "serviceType" | "detailPayload" | "requestedByDate" | "displayOrder">[] | null | undefined,
): {
  requestedByDate: string | null;
  requestedQuoteQuantities: number[];
} {
  const sorted = [...(items ?? [])].sort(
    (left, right) => (left.displayOrder ?? 0) - (right.displayOrder ?? 0),
  );
  const quoteCompatibleRequest = sorted.find((item) =>
    isQuoteCompatibleServiceKind(item.serviceType as RequestedServiceKind),
  );

  if (!quoteCompatibleRequest) {
    return {
      requestedByDate: null,
      requestedQuoteQuantities: [],
    };
  }

  return {
    requestedByDate: quoteCompatibleRequest.requestedByDate ?? null,
    requestedQuoteQuantities: readServiceRequestQuoteQuantities(quoteCompatibleRequest.detailPayload),
  };
}

export function readServiceRequestQuoteQuantities(detailPayload: Json | null | undefined): number[] {
  const payload = asObject(detailPayload);

  return normalizeRequestedQuoteQuantities(
    Array.isArray(payload.requestedQuoteQuantities)
      ? payload.requestedQuoteQuantities.filter((value): value is number => Number.isFinite(value))
      : [],
  );
}
