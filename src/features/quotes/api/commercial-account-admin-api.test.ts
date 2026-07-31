import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getCommercialAccount,
  listCommercialAccountAudit,
  searchCommercialAccounts,
} from "./commercial-account-admin-api";

const { callUntypedRpcMock } = vi.hoisted(() => ({
  callUntypedRpcMock: vi.fn(),
}));

vi.mock("./shared/rpc", () => ({
  callUntypedRpc: callUntypedRpcMock,
}));

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
});
