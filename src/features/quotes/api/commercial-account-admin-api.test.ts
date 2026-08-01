import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getCommercialAccount,
  grantCommercialEntitlement,
  listCommercialAccountAudit,
  revokeCommercialEntitlement,
  searchCommercialAccounts,
} from "./commercial-account-admin-api";

const { callUntypedRpcMock } = vi.hoisted(() => ({
  callUntypedRpcMock: vi.fn(),
}));

vi.mock("./shared/rpc", () => ({
  callUntypedRpc: callUntypedRpcMock,
}));

function makeRawAccountDetail(organizationId: string) {
  return {
    organization: {
      id: organizationId,
      name: "Apex Manufacturing",
      slug: "apex-manufacturing",
      createdAt: "2026-07-01T10:00:00Z",
    },
    members: [],
    billingAccount: null,
    effective: {
      plan: "free",
      source: "default",
      sourceId: null,
      automaticQuoteCollection: false,
      validUntil: null,
      reviewAt: null,
      reviewDue: false,
      graceEndsAt: null,
      organizationExists: true,
    },
    grants: [],
    subscriptions: [],
    quoteActivity: {
      manualRequestCount: 0,
      automaticRequestCount: 0,
      activeManualRequestCount: 0,
      receivedRequestCount: 0,
      failedRequestCount: 0,
      lastRequestAt: null,
      recentRequests: [],
    },
  };
}

function makeRawAuditEvent(organizationId: string) {
  return {
    eventId: "event-1",
    organizationId,
    actorUserId: "admin-1",
    actorEmail: "admin@example.com",
    action: "organization_entitlement.grant",
    targetType: "organization_entitlement",
    targetId: "grant-1",
    reason: "Audited pilot access",
    beforeState: null,
    afterState: null,
    requestMetadata: {},
    idempotencyKey: "intent-1",
    createdAt: "2026-07-30T10:00:00Z",
  };
}

describe("commercial-account-admin-api", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("searches commercial accounts with an opaque cursor and normalizes the page", async () => {
    callUntypedRpcMock.mockResolvedValue({
      data: {
        items: [
          {
            organizationId: "org-1",
            organizationName: "Apex Manufacturing",
            organizationSlug: "apex-manufacturing",
            createdAt: "2026-07-01T10:00:00Z",
            memberCount: "2",
            matchingMemberEmails: ["owner@apex.test", 42],
            effective: {
              plan: "pro",
              source: "manual_trial",
              sourceId: "grant-1",
              automaticQuoteCollection: true,
              validUntil: "2026-08-01T10:00:00Z",
              reviewAt: null,
              reviewDue: false,
              graceEndsAt: null,
              organizationExists: true,
            },
            quoteActivity: {
              manualRequestCount: "5",
              automaticRequestCount: 3,
              activeManualRequestCount: "1",
              lastRequestAt: "2026-07-30T10:00:00Z",
            },
            ignoredServerField: "not part of the client contract",
          },
        ],
        nextCursor: "opaque-search-cursor",
      },
      error: null,
    });

    const result = await searchCommercialAccounts({
      search: " owner@apex.test ",
      cursor: "opaque-prior-cursor",
      limit: 10,
    });

    expect(callUntypedRpcMock).toHaveBeenCalledWith(
      "api_admin_search_commercial_accounts",
      {
        p_search: " owner@apex.test ",
        p_cursor: "opaque-prior-cursor",
        p_limit: 10,
      },
    );
    expect(result).toEqual({
      items: [
        {
          organizationId: "org-1",
          organizationName: "Apex Manufacturing",
          organizationSlug: "apex-manufacturing",
          createdAt: "2026-07-01T10:00:00Z",
          memberCount: 2,
          matchingMemberEmails: ["owner@apex.test"],
          effective: {
            plan: "pro",
            source: "manual_trial",
            sourceId: "grant-1",
            automaticQuoteCollection: true,
            validUntil: "2026-08-01T10:00:00Z",
            reviewAt: null,
            reviewDue: false,
            graceEndsAt: null,
            organizationExists: true,
          },
          quoteActivity: {
            manualRequestCount: 5,
            automaticRequestCount: 3,
            activeManualRequestCount: 1,
            lastRequestAt: "2026-07-30T10:00:00Z",
          },
        },
      ],
      nextCursor: "opaque-search-cursor",
    });
  });

  it("loads and normalizes complete commercial-account detail", async () => {
    callUntypedRpcMock.mockResolvedValue({
      data: {
        organization: {
          id: "org-1",
          name: "Apex Manufacturing",
          slug: "apex-manufacturing",
          createdAt: "2026-07-01T10:00:00Z",
        },
        members: [
          {
            userId: "user-1",
            email: "owner@apex.test",
            role: "admin",
            joinedAt: "2026-07-01T10:05:00Z",
          },
          {
            userId: "user-2",
            email: null,
            role: "client",
            joinedAt: "2026-07-02T10:05:00Z",
          },
        ],
        billingAccount: {
          stripeCustomerId: null,
          createdAt: "2026-07-01T10:00:00Z",
          updatedAt: "2026-07-01T10:00:00Z",
        },
        effective: {
          plan: "pro",
          source: "manual_complimentary",
          sourceId: "grant-1",
          automaticQuoteCollection: true,
          validUntil: null,
          reviewAt: "2026-10-01T10:00:00Z",
          reviewDue: false,
          graceEndsAt: null,
          organizationExists: true,
        },
        grants: [
          {
            id: "grant-1",
            entitlementKey: "automatic_quote_collection",
            type: "complimentary",
            startsAt: "2026-07-01T10:00:00Z",
            expiresAt: null,
            reviewAt: "2026-10-01T10:00:00Z",
            reason: "Audited pilot access",
            grantedByUserId: "admin-1",
            revokedAt: null,
            revokedByUserId: null,
            revocationReason: null,
            createdAt: "2026-07-01T10:00:00Z",
          },
        ],
        subscriptions: [
          {
            id: "subscription-projection-1",
            stripeSubscriptionId: "sub_OverDrafter1",
            status: "past_due",
            billingInterval: "month",
            currentPeriodEnd: "2026-08-01T10:00:00Z",
            pastDueSince: "2026-07-29T10:00:00Z",
            cancelAtPeriodEnd: false,
            stripeEventCreatedAt: "2026-07-29T10:00:00Z",
            updatedAt: "2026-07-29T10:00:00Z",
          },
        ],
        quoteActivity: {
          manualRequestCount: "5",
          automaticRequestCount: "3",
          activeManualRequestCount: 1,
          receivedRequestCount: "6",
          failedRequestCount: 1,
          lastRequestAt: "2026-07-30T10:00:00Z",
          recentRequests: [
            {
              requestId: "request-1",
              jobId: "job-1",
              jobTitle: "Gear housing",
              requestMode: "manual",
              status: "received",
              createdAt: "2026-07-30T10:00:00Z",
            },
          ],
        },
      },
      error: null,
    });

    const result = await getCommercialAccount("org-1");

    expect(callUntypedRpcMock).toHaveBeenCalledWith(
      "api_admin_get_commercial_account",
      {
        p_organization_id: "org-1",
      },
    );
    expect(result).toEqual({
      organization: {
        id: "org-1",
        name: "Apex Manufacturing",
        slug: "apex-manufacturing",
        createdAt: "2026-07-01T10:00:00Z",
      },
      members: [
        {
          userId: "user-1",
          email: "owner@apex.test",
          role: "admin",
          joinedAt: "2026-07-01T10:05:00Z",
        },
        {
          userId: "user-2",
          email: null,
          role: "client",
          joinedAt: "2026-07-02T10:05:00Z",
        },
      ],
      billingAccount: {
        stripeCustomerId: null,
        createdAt: "2026-07-01T10:00:00Z",
        updatedAt: "2026-07-01T10:00:00Z",
      },
      effective: {
        plan: "pro",
        source: "manual_complimentary",
        sourceId: "grant-1",
        automaticQuoteCollection: true,
        validUntil: null,
        reviewAt: "2026-10-01T10:00:00Z",
        reviewDue: false,
        graceEndsAt: null,
        organizationExists: true,
      },
      grants: [
        {
          id: "grant-1",
          entitlementKey: "automatic_quote_collection",
          type: "complimentary",
          startsAt: "2026-07-01T10:00:00Z",
          expiresAt: null,
          reviewAt: "2026-10-01T10:00:00Z",
          reason: "Audited pilot access",
          grantedByUserId: "admin-1",
          revokedAt: null,
          revokedByUserId: null,
          revocationReason: null,
          createdAt: "2026-07-01T10:00:00Z",
        },
      ],
      subscriptions: [
        {
          id: "subscription-projection-1",
          stripeSubscriptionId: "sub_OverDrafter1",
          status: "past_due",
          billingInterval: "month",
          currentPeriodEnd: "2026-08-01T10:00:00Z",
          pastDueSince: "2026-07-29T10:00:00Z",
          cancelAtPeriodEnd: false,
          stripeEventCreatedAt: "2026-07-29T10:00:00Z",
          updatedAt: "2026-07-29T10:00:00Z",
        },
      ],
      quoteActivity: {
        manualRequestCount: 5,
        automaticRequestCount: 3,
        activeManualRequestCount: 1,
        receivedRequestCount: 6,
        failedRequestCount: 1,
        lastRequestAt: "2026-07-30T10:00:00Z",
        recentRequests: [
          {
            requestId: "request-1",
            jobId: "job-1",
            jobTitle: "Gear housing",
            requestMode: "manual",
            status: "received",
            createdAt: "2026-07-30T10:00:00Z",
          },
        ],
      },
    });
  });

  it("fails closed when account detail belongs to a different organization", async () => {
    callUntypedRpcMock.mockResolvedValue({
      data: makeRawAccountDetail("org-other"),
      error: null,
    });

    await expect(getCommercialAccount("org-1")).rejects.toThrow(
      "Commercial account detail returned an unexpected organization.",
    );
  });

  it("accepts equivalent canonical and decorated UUID spellings", async () => {
    const canonicalOrganizationId = "abcdef12-3456-7890-abcd-ef1234567890";
    callUntypedRpcMock
      .mockResolvedValueOnce({
        data: makeRawAccountDetail(canonicalOrganizationId),
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          items: [makeRawAuditEvent(canonicalOrganizationId)],
          nextCursor: null,
        },
        error: null,
      });

    await expect(
      getCommercialAccount("{ABCDEF12-3456-7890-ABCD-EF1234567890}"),
    ).resolves.toMatchObject({
      organization: { id: canonicalOrganizationId },
    });
    await expect(
      listCommercialAccountAudit({
        organizationId: "ABCDEF1234567890ABCDEF1234567890",
      }),
    ).resolves.toMatchObject({
      items: [{ organizationId: canonicalOrganizationId }],
    });
  });

  it("preserves nullable detail fields for a free account", async () => {
    callUntypedRpcMock.mockResolvedValue({
      data: {
        organization: {
          id: "org-free",
          name: "Free Shop",
          slug: "free-shop",
          createdAt: "2026-07-01T10:00:00Z",
        },
        members: [],
        billingAccount: null,
        effective: {
          plan: "free",
          source: "default",
          sourceId: null,
          automaticQuoteCollection: false,
          validUntil: null,
          reviewAt: null,
          reviewDue: false,
          graceEndsAt: null,
          organizationExists: true,
        },
        grants: [],
        subscriptions: [],
        quoteActivity: {
          manualRequestCount: 0,
          automaticRequestCount: 0,
          activeManualRequestCount: 0,
          receivedRequestCount: 0,
          failedRequestCount: 0,
          lastRequestAt: null,
          recentRequests: [],
        },
      },
      error: null,
    });

    await expect(getCommercialAccount("org-free")).resolves.toMatchObject({
      billingAccount: null,
      effective: {
        plan: "free",
        sourceId: null,
        validUntil: null,
        reviewAt: null,
        graceEndsAt: null,
      },
      quoteActivity: {
        lastRequestAt: null,
      },
    });
  });

  it("uses null cursors and the bounded default page size", async () => {
    callUntypedRpcMock.mockResolvedValue({
      data: {
        items: [],
        nextCursor: null,
      },
      error: null,
    });

    await searchCommercialAccounts();

    expect(callUntypedRpcMock).toHaveBeenCalledWith(
      "api_admin_search_commercial_accounts",
      {
        p_search: null,
        p_cursor: null,
        p_limit: 25,
      },
    );
  });

  it("loads and normalizes an organization-bound opaque-cursor audit page", async () => {
    callUntypedRpcMock.mockResolvedValue({
      data: {
        items: [
          {
            eventId: "event-1",
            organizationId: "org-1",
            actorUserId: "admin-1",
            actorEmail: null,
            action: "organization_entitlement.grant",
            targetType: "organization_entitlement",
            targetId: "grant-1",
            reason: "Audited pilot access",
            beforeState: null,
            afterState: {
              grantType: "complimentary",
            },
            requestMetadata: {
              interface: "commercial_account_admin",
            },
            idempotencyKey: "org-1-grant-1",
            createdAt: "2026-07-30T10:00:00Z",
            ignoredServerField: true,
          },
        ],
        nextCursor: "opaque-audit-cursor",
      },
      error: null,
    });

    const result = await listCommercialAccountAudit({
      organizationId: "org-1",
      cursor: "opaque-prior-cursor",
      limit: 20,
    });

    expect(callUntypedRpcMock).toHaveBeenCalledWith(
      "api_admin_list_commercial_account_audit",
      {
        p_organization_id: "org-1",
        p_cursor: "opaque-prior-cursor",
        p_limit: 20,
      },
    );
    expect(result).toEqual({
      items: [
        {
          eventId: "event-1",
          organizationId: "org-1",
          actorUserId: "admin-1",
          actorEmail: null,
          action: "organization_entitlement.grant",
          targetType: "organization_entitlement",
          targetId: "grant-1",
          reason: "Audited pilot access",
          beforeState: null,
          afterState: {
            grantType: "complimentary",
          },
          requestMetadata: {
            interface: "commercial_account_admin",
          },
          idempotencyKey: "org-1-grant-1",
          createdAt: "2026-07-30T10:00:00Z",
        },
      ],
      nextCursor: "opaque-audit-cursor",
    });
  });

  it("fails closed when an audit event belongs to a different organization", async () => {
    callUntypedRpcMock.mockResolvedValue({
      data: {
        items: [makeRawAuditEvent("org-other")],
        nextCursor: null,
      },
      error: null,
    });

    await expect(
      listCommercialAccountAudit({ organizationId: "org-1" }),
    ).rejects.toThrow(
      "Commercial account audit returned an unexpected organization.",
    );
  });

  it.each([
    [
      "search page",
      () => searchCommercialAccounts({}),
      {
        data: {
          items: "not-an-array",
          nextCursor: null,
        },
        error: null,
      },
    ],
    [
      "account detail",
      () => getCommercialAccount("org-1"),
      {
        data: {
          organization: {
            id: "org-1",
            name: "Apex Manufacturing",
            slug: "apex-manufacturing",
            createdAt: "2026-07-01T10:00:00Z",
          },
          members: "not-an-array",
          billingAccount: null,
          effective: {
            plan: "free",
            source: "default",
            sourceId: null,
            automaticQuoteCollection: false,
            validUntil: null,
            reviewAt: null,
            reviewDue: false,
            graceEndsAt: null,
            organizationExists: true,
          },
          grants: [],
          subscriptions: [],
          quoteActivity: {
            manualRequestCount: 0,
            automaticRequestCount: 0,
            activeManualRequestCount: 0,
            receivedRequestCount: 0,
            failedRequestCount: 0,
            lastRequestAt: null,
            recentRequests: [],
          },
        },
        error: null,
      },
    ],
    [
      "audit page",
      () =>
        listCommercialAccountAudit({
          organizationId: "org-1",
        }),
      {
        data: {
          items: [
            {
              eventId: "event-1",
              organizationId: "org-1",
              actorUserId: "admin-1",
              actorEmail: null,
              action: "organization_entitlement.grant",
              targetType: "organization_entitlement",
              targetId: "grant-1",
              reason: "Audited pilot access",
              beforeState: [],
              afterState: null,
              requestMetadata: {},
              idempotencyKey: "org-1-grant-1",
              createdAt: "2026-07-30T10:00:00Z",
            },
          ],
          nextCursor: null,
        },
        error: null,
      },
    ],
  ])("fails closed for an invalid %s response", async (_label, call, response) => {
    callUntypedRpcMock.mockResolvedValue(response);

    await expect(call()).rejects.toThrow(TypeError);
  });

  it.each([null, false, true, [], "", "  "])(
    "rejects a non-numeric quote count instead of coercing %j",
    async (manualRequestCount) => {
      callUntypedRpcMock.mockResolvedValue({
        data: {
          items: [
            {
              organizationId: "org-1",
              organizationName: "Apex Manufacturing",
              organizationSlug: "apex-manufacturing",
              createdAt: "2026-07-01T10:00:00Z",
              memberCount: 1,
              matchingMemberEmails: [],
              effective: {
                plan: "free",
                source: "default",
                sourceId: null,
                automaticQuoteCollection: false,
                validUntil: null,
                reviewAt: null,
                reviewDue: false,
                graceEndsAt: null,
                organizationExists: true,
              },
              quoteActivity: {
                manualRequestCount,
                automaticRequestCount: 0,
                activeManualRequestCount: 0,
                lastRequestAt: null,
              },
            },
          ],
          nextCursor: null,
        },
        error: null,
      });

      await expect(searchCommercialAccounts()).rejects.toThrow(TypeError);
    },
  );

  it("rejects a non-string billing interval", async () => {
    callUntypedRpcMock.mockResolvedValue({
      data: {
        organization: {
          id: "org-1",
          name: "Apex Manufacturing",
          slug: "apex-manufacturing",
          createdAt: "2026-07-01T10:00:00Z",
        },
        members: [],
        billingAccount: null,
        effective: {
          plan: "pro",
          source: "subscription_active",
          sourceId: "subscription-1",
          automaticQuoteCollection: true,
          validUntil: "2026-08-01T10:00:00Z",
          reviewAt: null,
          reviewDue: false,
          graceEndsAt: null,
          organizationExists: true,
        },
        grants: [],
        subscriptions: [
          {
            id: "subscription-1",
            stripeSubscriptionId: "sub_OverDrafter1",
            status: "active",
            billingInterval: 42,
            currentPeriodEnd: "2026-08-01T10:00:00Z",
            pastDueSince: null,
            cancelAtPeriodEnd: false,
            stripeEventCreatedAt: "2026-07-29T10:00:00Z",
            updatedAt: "2026-07-29T10:00:00Z",
          },
        ],
        quoteActivity: {
          manualRequestCount: 0,
          automaticRequestCount: 0,
          activeManualRequestCount: 0,
          receivedRequestCount: 0,
          failedRequestCount: 0,
          lastRequestAt: null,
          recentRequests: [],
        },
      },
      error: null,
    });

    await expect(getCommercialAccount("org-1")).rejects.toThrow(TypeError);
  });

  it("propagates an RPC error without attempting to normalize data", async () => {
    const rpcError = { message: "Commercial account access denied." };
    callUntypedRpcMock.mockResolvedValue({
      data: null,
      error: rpcError,
    });

    await expect(searchCommercialAccounts()).rejects.toBe(rpcError);
  });

  it("passes exact grant intent and normalizes an idempotent replay", async () => {
    callUntypedRpcMock.mockResolvedValue({
      data: {
        grantId: "grant-1",
        supersededGrantIds: ["grant-old"],
        effective: {
          plan: "pro",
          source: "manual_trial",
          sourceId: "grant-1",
          automaticQuoteCollection: true,
          validUntil: "2026-08-31T10:00:00Z",
          reviewAt: null,
          reviewDue: false,
          graceEndsAt: null,
          organizationExists: true,
        },
        eventId: "event-1",
        replayed: true,
        ignoredServerField: "not part of the client contract",
      },
      error: null,
    });

    const result = await grantCommercialEntitlement({
      organizationId: "org-1",
      grantType: "trial",
      startsAt: "2026-07-31T10:00:00Z",
      expiresAt: "2026-08-31T10:00:00Z",
      reviewAt: null,
      reason: "Thirty-day evaluation",
      idempotencyKey: "org-1-trial-2026-07-31",
    });

    expect(callUntypedRpcMock).toHaveBeenCalledWith(
      "api_admin_grant_organization_entitlement",
      {
        p_organization_id: "org-1",
        p_grant_type: "trial",
        p_starts_at: "2026-07-31T10:00:00Z",
        p_expires_at: "2026-08-31T10:00:00Z",
        p_review_at: null,
        p_reason: "Thirty-day evaluation",
        p_idempotency_key: "org-1-trial-2026-07-31",
      },
    );
    expect(result).toEqual({
      grantId: "grant-1",
      supersededGrantIds: ["grant-old"],
      effective: {
        plan: "pro",
        source: "manual_trial",
        sourceId: "grant-1",
        automaticQuoteCollection: true,
        validUntil: "2026-08-31T10:00:00Z",
        reviewAt: null,
        reviewDue: false,
        graceEndsAt: null,
        organizationExists: true,
      },
      eventId: "event-1",
      replayed: true,
    });
  });

  it("passes exact revocation intent and normalizes the result", async () => {
    callUntypedRpcMock.mockResolvedValue({
      data: {
        grantId: "grant-1",
        revokedAt: "2026-07-31T12:00:00Z",
        effective: {
          plan: "free",
          source: "default",
          sourceId: null,
          automaticQuoteCollection: false,
          validUntil: null,
          reviewAt: null,
          reviewDue: false,
          graceEndsAt: null,
          organizationExists: true,
        },
        eventId: "event-2",
        replayed: false,
        ignoredServerField: true,
      },
      error: null,
    });

    const result = await revokeCommercialEntitlement({
      grantId: "grant-1",
      reason: "Pilot concluded",
      idempotencyKey: "grant-1-revoke",
    });

    expect(callUntypedRpcMock).toHaveBeenCalledWith(
      "api_admin_revoke_organization_entitlement",
      {
        p_grant_id: "grant-1",
        p_reason: "Pilot concluded",
        p_idempotency_key: "grant-1-revoke",
      },
    );
    expect(result).toEqual({
      grantId: "grant-1",
      revokedAt: "2026-07-31T12:00:00Z",
      effective: {
        plan: "free",
        source: "default",
        sourceId: null,
        automaticQuoteCollection: false,
        validUntil: null,
        reviewAt: null,
        reviewDue: false,
        graceEndsAt: null,
        organizationExists: true,
      },
      eventId: "event-2",
      replayed: false,
    });
  });

  it.each([
    [
      "grant",
      () =>
        grantCommercialEntitlement({
          organizationId: "org-1",
          grantType: "complimentary",
          startsAt: "2026-07-31T10:00:00Z",
          expiresAt: null,
          reviewAt: "2026-10-31T10:00:00Z",
          reason: "Audited pilot",
          idempotencyKey: "org-1-complimentary-2026-07-31",
        }),
      {
        data: {
          grantId: "grant-1",
          supersededGrantIds: [],
          effective: {
            plan: "pro",
            source: "manual_complimentary",
            sourceId: "grant-1",
            automaticQuoteCollection: true,
            validUntil: null,
            reviewAt: "2026-10-31T10:00:00Z",
            reviewDue: false,
            graceEndsAt: null,
            organizationExists: true,
          },
          eventId: "event-1",
          replayed: "true",
        },
        error: null,
      },
    ],
    [
      "revocation",
      () =>
        revokeCommercialEntitlement({
          grantId: "grant-1",
          reason: "Pilot concluded",
          idempotencyKey: "grant-1-revoke",
        }),
      {
        data: {
          grantId: "grant-1",
          revokedAt: null,
          effective: {
            plan: "free",
            source: "default",
            sourceId: null,
            automaticQuoteCollection: false,
            validUntil: null,
            reviewAt: null,
            reviewDue: false,
            graceEndsAt: null,
            organizationExists: true,
          },
          eventId: "event-2",
          replayed: false,
        },
        error: null,
      },
    ],
  ])("fails closed for a malformed %s mutation response", async (_label, call, response) => {
    callUntypedRpcMock.mockResolvedValue(response);

    await expect(call()).rejects.toThrow(TypeError);
  });

  it.each([
    [
      "grant",
      () =>
        grantCommercialEntitlement({
          organizationId: "org-1",
          grantType: "trial",
          startsAt: "2026-07-31T10:00:00Z",
          expiresAt: "2026-08-31T10:00:00Z",
          reviewAt: null,
          reason: "Thirty-day evaluation",
          idempotencyKey: "org-1-trial-2026-07-31",
        }),
    ],
    [
      "revocation",
      () =>
        revokeCommercialEntitlement({
          grantId: "grant-1",
          reason: "Pilot concluded",
          idempotencyKey: "grant-1-revoke",
        }),
    ],
  ])("propagates a %s RPC error", async (_label, call) => {
    const rpcError = { message: "AAL2 is required." };
    callUntypedRpcMock.mockResolvedValue({ data: null, error: rpcError });

    await expect(call()).rejects.toBe(rpcError);
  });
});
