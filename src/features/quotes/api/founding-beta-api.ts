import { callRpc } from "@/features/quotes/api/shared/rpc";
import { ensureData } from "@/features/quotes/api/shared/response";
import {
  parseFoundingBetaAccess,
  type FoundingBetaAccess,
} from "@/features/quotes/founding-beta-access";

export async function getFoundingBetaAccess(
  organizationId: string,
): Promise<FoundingBetaAccess> {
  const { data, error } = await callRpc("api_get_founding_beta_access_state", {
    p_organization_id: organizationId,
  });

  return parseFoundingBetaAccess(ensureData(data, error));
}

export async function acceptFoundingBetaNotice(input: {
  organizationId: string;
  policyRevision: string;
}): Promise<FoundingBetaAccess> {
  const { data, error } = await callRpc("api_accept_founding_beta_notice", {
    p_organization_id: input.organizationId,
    p_policy_revision: input.policyRevision,
  });

  return parseFoundingBetaAccess(ensureData(data, error));
}
