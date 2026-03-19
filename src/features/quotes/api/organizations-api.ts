import type { AppRole } from "@/integrations/supabase/types";
import type { OrganizationMembershipSummary } from "@/features/quotes/types";
import { callRpc } from "./shared/rpc";
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
