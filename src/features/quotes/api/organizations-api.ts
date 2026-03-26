import type { AppRole } from "@/integrations/supabase/types";
import type { OrganizationDetails, OrganizationMembershipSummary } from "@/features/quotes/types";
import { callRpc, untypedSupabase } from "./shared/rpc";
import { ensureData } from "./shared/response";

export async function createSelfServiceOrganization(organizationName: string): Promise<string> {
  const { data, error } = await callRpc("api_create_self_service_organization", {
    p_organization_name: organizationName,
  });

  return ensureData(data, error);
}

export async function fetchOrganizationMemberships(
  organizationId: string,
): Promise<OrganizationMembershipSummary[]> {
  const { data, error } = await callRpc("api_list_organization_memberships", {
    p_organization_id: organizationId,
  });

  return ensureData(data, error) as OrganizationMembershipSummary[];
}

export async function updateOrganizationMembershipRole(input: {
  membershipId: string;
  role: AppRole;
}): Promise<string> {
  const { data, error } = await callRpc("api_update_organization_membership_role", {
    p_membership_id: input.membershipId,
    p_role: input.role,
  });

  return ensureData(data, error);
}

export async function fetchOrganizationDetails(organizationId: string): Promise<OrganizationDetails> {
  const { data, error } = await (
    untypedSupabase.from("organizations") as unknown as {
      select: (cols: string) => {
        eq: (col: string, val: string) => {
          single: () => Promise<{ data: Record<string, unknown> | null; error: unknown }>;
        };
      };
    }
  )
    .select(
      "id,name,company_name,logo_url,phone,billing_street,billing_city,billing_state,billing_zip,billing_country,shipping_same_as_billing,shipping_street,shipping_city,shipping_state,shipping_zip,shipping_country",
    )
    .eq("id", organizationId)
    .single();

  if (error || !data) throw new Error("Failed to fetch organization details");

  return {
    id: data["id"] as string,
    name: data["name"] as string,
    companyName: (data["company_name"] as string | null) ?? null,
    logoUrl: (data["logo_url"] as string | null) ?? null,
    phone: (data["phone"] as string | null) ?? null,
    billingStreet: (data["billing_street"] as string | null) ?? null,
    billingCity: (data["billing_city"] as string | null) ?? null,
    billingState: (data["billing_state"] as string | null) ?? null,
    billingZip: (data["billing_zip"] as string | null) ?? null,
    billingCountry: (data["billing_country"] as string | null) ?? "US",
    shippingSameAsBilling: (data["shipping_same_as_billing"] as boolean | null) ?? true,
    shippingStreet: (data["shipping_street"] as string | null) ?? null,
    shippingCity: (data["shipping_city"] as string | null) ?? null,
    shippingState: (data["shipping_state"] as string | null) ?? null,
    shippingZip: (data["shipping_zip"] as string | null) ?? null,
    shippingCountry: (data["shipping_country"] as string | null) ?? "US",
  };
}

export async function updateOrganizationDetails(
  organizationId: string,
  patch: Partial<Omit<OrganizationDetails, "id" | "name">>,
): Promise<void> {
  const row: Record<string, unknown> = {};
  if ("companyName" in patch) row["company_name"] = patch.companyName;
  if ("logoUrl" in patch) row["logo_url"] = patch.logoUrl;
  if ("phone" in patch) row["phone"] = patch.phone;
  if ("billingStreet" in patch) row["billing_street"] = patch.billingStreet;
  if ("billingCity" in patch) row["billing_city"] = patch.billingCity;
  if ("billingState" in patch) row["billing_state"] = patch.billingState;
  if ("billingZip" in patch) row["billing_zip"] = patch.billingZip;
  if ("billingCountry" in patch) row["billing_country"] = patch.billingCountry;
  if ("shippingSameAsBilling" in patch) row["shipping_same_as_billing"] = patch.shippingSameAsBilling;
  if ("shippingStreet" in patch) row["shipping_street"] = patch.shippingStreet;
  if ("shippingCity" in patch) row["shipping_city"] = patch.shippingCity;
  if ("shippingState" in patch) row["shipping_state"] = patch.shippingState;
  if ("shippingZip" in patch) row["shipping_zip"] = patch.shippingZip;
  if ("shippingCountry" in patch) row["shipping_country"] = patch.shippingCountry;

  const { error } = await (
    untypedSupabase.from("organizations") as unknown as {
      update: (values: Record<string, unknown>) => {
        eq: (col: string, val: string) => Promise<{ error: unknown }>;
      };
    }
  )
    .update(row)
    .eq("id", organizationId);

  if (error) throw new Error("Failed to update organization details");
}
