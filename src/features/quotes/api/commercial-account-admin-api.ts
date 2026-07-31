import { callUntypedRpc } from "./shared/rpc";
import { ensureData } from "./shared/response";

type UnknownRecord = Record<string, unknown>;

export type CommercialEffectiveEntitlement = {
  plan: "free" | "pro";
  source: string;
  sourceId: string | null;
  automaticQuoteCollection: boolean;
  validUntil: string | null;
  reviewAt: string | null;
  reviewDue: boolean;
  graceEndsAt: string | null;
  organizationExists: boolean;
};

export type CommercialQuoteActivitySummary = {
  manualRequestCount: number;
  automaticRequestCount: number;
  activeManualRequestCount: number;
  lastRequestAt: string | null;
};

export type CommercialAccountSearchItem = {
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
  createdAt: string;
  memberCount: number;
  matchingMemberEmails: string[];
  effective: CommercialEffectiveEntitlement;
  quoteActivity: CommercialQuoteActivitySummary;
};

export type CommercialAccountSearchPage = {
  items: CommercialAccountSearchItem[];
  nextCursor: string | null;
};

export type CommercialAccountMember = {
  userId: string;
  email: string | null;
  role: string;
  joinedAt: string;
};

export type CommercialBillingAccount = {
  stripeCustomerId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CommercialEntitlementGrant = {
  id: string;
  entitlementKey: string;
  type: "trial" | "complimentary";
  startsAt: string;
  expiresAt: string | null;
  reviewAt: string | null;
  reason: string;
  grantedByUserId: string;
  revokedAt: string | null;
  revokedByUserId: string | null;
  revocationReason: string | null;
  createdAt: string;
};

export type CommercialSubscriptionProjection = {
  id: string;
  stripeSubscriptionId: string;
  status: string;
  billingInterval: "month" | "year" | null;
  currentPeriodEnd: string | null;
  pastDueSince: string | null;
  cancelAtPeriodEnd: boolean;
  stripeEventCreatedAt: string;
  updatedAt: string;
};

export type CommercialRecentQuoteRequest = {
  requestId: string;
  jobId: string;
  jobTitle: string;
  requestMode: "manual" | "automatic";
  status: string;
  createdAt: string;
};

export type CommercialAccountQuoteActivity =
  CommercialQuoteActivitySummary & {
    receivedRequestCount: number;
    failedRequestCount: number;
    recentRequests: CommercialRecentQuoteRequest[];
  };

export type CommercialAccountDetail = {
  organization: {
    id: string;
    name: string;
    slug: string;
    createdAt: string;
  };
  members: CommercialAccountMember[];
  billingAccount: CommercialBillingAccount | null;
  effective: CommercialEffectiveEntitlement;
  grants: CommercialEntitlementGrant[];
  subscriptions: CommercialSubscriptionProjection[];
  quoteActivity: CommercialAccountQuoteActivity;
};

export type CommercialAccountAuditEvent = {
  eventId: string;
  organizationId: string;
  actorUserId: string;
  actorEmail: string | null;
  action: string;
  targetType: string;
  targetId: string;
  reason: string;
  beforeState: UnknownRecord | null;
  afterState: UnknownRecord | null;
  requestMetadata: UnknownRecord;
  idempotencyKey: string;
  createdAt: string;
};

export type CommercialAccountAuditPage = {
  items: CommercialAccountAuditEvent[];
  nextCursor: string | null;
};

function requireRecord(value: unknown, label: string): UnknownRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`Expected ${label} to be an object.`);
  }

  return value as UnknownRecord;
}

function nullableRecord(value: unknown, label: string): UnknownRecord | null {
  if (value === null || value === undefined) {
    return null;
  }

  return requireRecord(value, label);
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`Expected ${label} to be an array.`);
  }

  return value;
}

function requireString(
  record: UnknownRecord,
  key: string,
  label: string,
): string {
  const value = record[key];

  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} is missing ${key}.`);
  }

  return value;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function requireBoolean(
  record: UnknownRecord,
  key: string,
  label: string,
): boolean {
  const value = record[key];

  if (typeof value !== "boolean") {
    throw new TypeError(`${label} is missing ${key}.`);
  }

  return value;
}

function requireNonNegativeInteger(
  record: UnknownRecord,
  key: string,
  label: string,
): number {
  const raw = record[key];

  if (typeof raw !== "number" && typeof raw !== "string") {
    throw new TypeError(`${label} has an invalid ${key}.`);
  }

  if (typeof raw === "string" && raw.trim().length === 0) {
    throw new TypeError(`${label} has an invalid ${key}.`);
  }

  const value = Number(raw);

  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${label} has an invalid ${key}.`);
  }

  return value;
}

function normalizeEffectiveEntitlement(
  value: unknown,
): CommercialEffectiveEntitlement {
  const record = requireRecord(value, "commercial effective entitlement");
  const plan = requireString(
    record,
    "plan",
    "Commercial effective entitlement",
  );

  if (plan !== "free" && plan !== "pro") {
    throw new TypeError("Commercial effective entitlement has an invalid plan.");
  }

  return {
    plan,
    source: requireString(
      record,
      "source",
      "Commercial effective entitlement",
    ),
    sourceId: nullableString(record.sourceId),
    automaticQuoteCollection: requireBoolean(
      record,
      "automaticQuoteCollection",
      "Commercial effective entitlement",
    ),
    validUntil: nullableString(record.validUntil),
    reviewAt: nullableString(record.reviewAt),
    reviewDue: requireBoolean(
      record,
      "reviewDue",
      "Commercial effective entitlement",
    ),
    graceEndsAt: nullableString(record.graceEndsAt),
    organizationExists: requireBoolean(
      record,
      "organizationExists",
      "Commercial effective entitlement",
    ),
  };
}

function normalizeQuoteActivitySummary(
  value: unknown,
  label: string,
): CommercialQuoteActivitySummary {
  const record = requireRecord(value, label);

  return {
    manualRequestCount: requireNonNegativeInteger(
      record,
      "manualRequestCount",
      label,
    ),
    automaticRequestCount: requireNonNegativeInteger(
      record,
      "automaticRequestCount",
      label,
    ),
    activeManualRequestCount: requireNonNegativeInteger(
      record,
      "activeManualRequestCount",
      label,
    ),
    lastRequestAt: nullableString(record.lastRequestAt),
  };
}

function normalizeSearchItem(value: unknown): CommercialAccountSearchItem {
  const record = requireRecord(value, "commercial account search item");
  const matchingMemberEmails = requireArray(
    record.matchingMemberEmails,
    "matching member emails",
  ).filter((email): email is string => typeof email === "string");

  return {
    organizationId: requireString(
      record,
      "organizationId",
      "Commercial account search item",
    ),
    organizationName: requireString(
      record,
      "organizationName",
      "Commercial account search item",
    ),
    organizationSlug: requireString(
      record,
      "organizationSlug",
      "Commercial account search item",
    ),
    createdAt: requireString(
      record,
      "createdAt",
      "Commercial account search item",
    ),
    memberCount: requireNonNegativeInteger(
      record,
      "memberCount",
      "Commercial account search item",
    ),
    matchingMemberEmails,
    effective: normalizeEffectiveEntitlement(record.effective),
    quoteActivity: normalizeQuoteActivitySummary(
      record.quoteActivity,
      "Commercial account quote activity",
    ),
  };
}

function normalizeSearchPage(value: unknown): CommercialAccountSearchPage {
  const record = requireRecord(value, "commercial account search page");

  return {
    items: requireArray(
      record.items,
      "commercial account search items",
    ).map(normalizeSearchItem),
    nextCursor: nullableString(record.nextCursor),
  };
}

function normalizeMember(value: unknown): CommercialAccountMember {
  const record = requireRecord(value, "commercial account member");

  return {
    userId: requireString(record, "userId", "Commercial account member"),
    email: nullableString(record.email),
    role: requireString(record, "role", "Commercial account member"),
    joinedAt: requireString(record, "joinedAt", "Commercial account member"),
  };
}

function normalizeBillingAccount(value: unknown): CommercialBillingAccount | null {
  const record = nullableRecord(value, "commercial billing account");

  if (!record) {
    return null;
  }

  return {
    stripeCustomerId: nullableString(record.stripeCustomerId),
    createdAt: requireString(
      record,
      "createdAt",
      "Commercial billing account",
    ),
    updatedAt: requireString(
      record,
      "updatedAt",
      "Commercial billing account",
    ),
  };
}

function normalizeGrant(value: unknown): CommercialEntitlementGrant {
  const record = requireRecord(value, "commercial entitlement grant");
  const type = requireString(
    record,
    "type",
    "Commercial entitlement grant",
  );

  if (type !== "trial" && type !== "complimentary") {
    throw new TypeError("Commercial entitlement grant has an invalid type.");
  }

  return {
    id: requireString(record, "id", "Commercial entitlement grant"),
    entitlementKey: requireString(
      record,
      "entitlementKey",
      "Commercial entitlement grant",
    ),
    type,
    startsAt: requireString(
      record,
      "startsAt",
      "Commercial entitlement grant",
    ),
    expiresAt: nullableString(record.expiresAt),
    reviewAt: nullableString(record.reviewAt),
    reason: requireString(
      record,
      "reason",
      "Commercial entitlement grant",
    ),
    grantedByUserId: requireString(
      record,
      "grantedByUserId",
      "Commercial entitlement grant",
    ),
    revokedAt: nullableString(record.revokedAt),
    revokedByUserId: nullableString(record.revokedByUserId),
    revocationReason: nullableString(record.revocationReason),
    createdAt: requireString(
      record,
      "createdAt",
      "Commercial entitlement grant",
    ),
  };
}

function normalizeSubscription(
  value: unknown,
): CommercialSubscriptionProjection {
  const record = requireRecord(value, "commercial subscription projection");
  const billingInterval = record.billingInterval;
  let normalizedBillingInterval: "month" | "year" | null = null;

  if (billingInterval === "month" || billingInterval === "year") {
    normalizedBillingInterval = billingInterval;
  } else if (billingInterval !== null) {
    throw new TypeError(
      "Commercial subscription projection has an invalid billing interval.",
    );
  }

  return {
    id: requireString(record, "id", "Commercial subscription projection"),
    stripeSubscriptionId: requireString(
      record,
      "stripeSubscriptionId",
      "Commercial subscription projection",
    ),
    status: requireString(
      record,
      "status",
      "Commercial subscription projection",
    ),
    billingInterval: normalizedBillingInterval,
    currentPeriodEnd: nullableString(record.currentPeriodEnd),
    pastDueSince: nullableString(record.pastDueSince),
    cancelAtPeriodEnd: requireBoolean(
      record,
      "cancelAtPeriodEnd",
      "Commercial subscription projection",
    ),
    stripeEventCreatedAt: requireString(
      record,
      "stripeEventCreatedAt",
      "Commercial subscription projection",
    ),
    updatedAt: requireString(
      record,
      "updatedAt",
      "Commercial subscription projection",
    ),
  };
}

function normalizeRecentRequest(value: unknown): CommercialRecentQuoteRequest {
  const record = requireRecord(value, "commercial recent quote request");
  const requestMode = requireString(
    record,
    "requestMode",
    "Commercial recent quote request",
  );

  if (requestMode !== "manual" && requestMode !== "automatic") {
    throw new TypeError("Commercial recent quote request has an invalid mode.");
  }

  return {
    requestId: requireString(
      record,
      "requestId",
      "Commercial recent quote request",
    ),
    jobId: requireString(
      record,
      "jobId",
      "Commercial recent quote request",
    ),
    jobTitle: requireString(
      record,
      "jobTitle",
      "Commercial recent quote request",
    ),
    requestMode,
    status: requireString(
      record,
      "status",
      "Commercial recent quote request",
    ),
    createdAt: requireString(
      record,
      "createdAt",
      "Commercial recent quote request",
    ),
  };
}

function normalizeAccountDetail(value: unknown): CommercialAccountDetail {
  const record = requireRecord(value, "commercial account detail");
  const organization = requireRecord(
    record.organization,
    "commercial account organization",
  );
  const quoteActivityRecord = requireRecord(
    record.quoteActivity,
    "commercial account quote activity",
  );
  const quoteActivitySummary = normalizeQuoteActivitySummary(
    quoteActivityRecord,
    "Commercial account quote activity",
  );

  return {
    organization: {
      id: requireString(
        organization,
        "id",
        "Commercial account organization",
      ),
      name: requireString(
        organization,
        "name",
        "Commercial account organization",
      ),
      slug: requireString(
        organization,
        "slug",
        "Commercial account organization",
      ),
      createdAt: requireString(
        organization,
        "createdAt",
        "Commercial account organization",
      ),
    },
    members: requireArray(record.members, "commercial account members").map(
      normalizeMember,
    ),
    billingAccount: normalizeBillingAccount(record.billingAccount),
    effective: normalizeEffectiveEntitlement(record.effective),
    grants: requireArray(record.grants, "commercial entitlement grants").map(
      normalizeGrant,
    ),
    subscriptions: requireArray(
      record.subscriptions,
      "commercial subscription projections",
    ).map(normalizeSubscription),
    quoteActivity: {
      ...quoteActivitySummary,
      receivedRequestCount: requireNonNegativeInteger(
        quoteActivityRecord,
        "receivedRequestCount",
        "Commercial account quote activity",
      ),
      failedRequestCount: requireNonNegativeInteger(
        quoteActivityRecord,
        "failedRequestCount",
        "Commercial account quote activity",
      ),
      recentRequests: requireArray(
        quoteActivityRecord.recentRequests,
        "commercial recent quote requests",
      ).map(normalizeRecentRequest),
    },
  };
}

function normalizeAuditEvent(value: unknown): CommercialAccountAuditEvent {
  const record = requireRecord(value, "commercial account audit event");

  return {
    eventId: requireString(
      record,
      "eventId",
      "Commercial account audit event",
    ),
    organizationId: requireString(
      record,
      "organizationId",
      "Commercial account audit event",
    ),
    actorUserId: requireString(
      record,
      "actorUserId",
      "Commercial account audit event",
    ),
    actorEmail: nullableString(record.actorEmail),
    action: requireString(
      record,
      "action",
      "Commercial account audit event",
    ),
    targetType: requireString(
      record,
      "targetType",
      "Commercial account audit event",
    ),
    targetId: requireString(
      record,
      "targetId",
      "Commercial account audit event",
    ),
    reason: requireString(
      record,
      "reason",
      "Commercial account audit event",
    ),
    beforeState: nullableRecord(
      record.beforeState,
      "commercial audit before state",
    ),
    afterState: nullableRecord(
      record.afterState,
      "commercial audit after state",
    ),
    requestMetadata: requireRecord(
      record.requestMetadata,
      "commercial audit request metadata",
    ),
    idempotencyKey: requireString(
      record,
      "idempotencyKey",
      "Commercial account audit event",
    ),
    createdAt: requireString(
      record,
      "createdAt",
      "Commercial account audit event",
    ),
  };
}

function normalizeAuditPage(value: unknown): CommercialAccountAuditPage {
  const record = requireRecord(value, "commercial account audit page");

  return {
    items: requireArray(record.items, "commercial account audit items").map(
      normalizeAuditEvent,
    ),
    nextCursor: nullableString(record.nextCursor),
  };
}

/**
 * Searches commercial accounts through the billing-admin capability boundary.
 *
 * The continuation token is opaque and must be returned to the server without
 * decoding or modification.
 */
export async function searchCommercialAccounts(input: {
  search?: string | null;
  cursor?: string | null;
  limit?: number;
} = {}): Promise<CommercialAccountSearchPage> {
  const { data, error } = await callUntypedRpc(
    "api_admin_search_commercial_accounts",
    {
      p_search: input.search ?? null,
      p_cursor: input.cursor ?? null,
      p_limit: input.limit ?? 25,
    },
  );

  return normalizeSearchPage(ensureData(data, error));
}

/**
 * Loads the exact commercial projection for one organization.
 */
export async function getCommercialAccount(
  organizationId: string,
): Promise<CommercialAccountDetail> {
  const { data, error } = await callUntypedRpc(
    "api_admin_get_commercial_account",
    {
      p_organization_id: organizationId,
    },
  );

  return normalizeAccountDetail(ensureData(data, error));
}

/**
 * Loads one organization-bound page of billing-administration audit history.
 */
export async function listCommercialAccountAudit(input: {
  organizationId: string;
  cursor?: string | null;
  limit?: number;
}): Promise<CommercialAccountAuditPage> {
  const { data, error } = await callUntypedRpc(
    "api_admin_list_commercial_account_audit",
    {
      p_organization_id: input.organizationId,
      p_cursor: input.cursor ?? null,
      p_limit: input.limit ?? 25,
    },
  );

  return normalizeAuditPage(ensureData(data, error));
}
