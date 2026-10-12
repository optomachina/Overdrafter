import { createSupabaseChatGptReader, type OverdrafterConnection } from "./supabase-reader";

export const syntheticJobId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const syntheticOrganizationId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const syntheticUserId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

export const syntheticConnection: OverdrafterConnection = {
  userId: syntheticUserId, organizationId: syntheticOrganizationId,
  accessToken: "synthetic-upstream-token", scopes: ["overdrafter:read"],
};

/** Fake Supabase HTTP responses exercise the real reader without network access. */
export function createSyntheticChatGptReader(connection = syntheticConnection) {
  return createSupabaseChatGptReader({
    url: "https://synthetic.invalid", publishableKey: "sb_publishable_synthetic_only",
    connection,
    isEnabled: () => true,
    fetch: (input) => Promise.resolve(syntheticResponse(input)),
  });
}

function syntheticResponse(input: Parameters<typeof fetch>[0]): Response {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.pathname === "/auth/v1/user") return Response.json({ id: syntheticUserId, is_anonymous: false });
  if (url.pathname === "/rest/v1/organization_memberships") return Response.json({ organization_id: syntheticOrganizationId });
  if (url.pathname === "/rest/v1/jobs") {
    if (url.searchParams.get("id") !== `eq.${syntheticJobId}`) return Response.json(null);
    return Response.json({ id: syntheticJobId, organization_id: syntheticOrganizationId, status: "quoting" });
  }
  if (url.pathname === "/rest/v1/rpc/api_list_client_quote_workspace") return Response.json([{
    jobId: syntheticJobId, vendorQuotes: [{
      id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", organization_id: syntheticOrganizationId,
      vendor: "Synthetic vendor", status: "instant_quote_received", requested_quantity: 1,
      total_price_usd: 125, lead_time_business_days: 7, raw_payload: { private: "must not escape" },
    }],
  }]);
  throw new Error("Unexpected synthetic endpoint");
}
