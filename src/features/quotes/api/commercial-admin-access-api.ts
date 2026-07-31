import { callUntypedRpc } from "./shared/rpc";
import { ensureData } from "./shared/response";

export type CommercialAdminAccess = {
  hasCapability: boolean;
  hasAal2: boolean;
};

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new TypeError(`${label} must be a boolean.`);
  }

  return value;
}

/**
 * Resolves billing-administrator capability and MFA assurance independently.
 *
 * Read-only commercial account access needs the capability. Grant and revoke
 * mutations additionally require the AAL2 session enforced by the server.
 */
export async function fetchCommercialAdminAccess(): Promise<CommercialAdminAccess> {
  const [capabilityResult, aal2Result] = await Promise.all([
    callUntypedRpc("current_user_has_commercial_capability", {
      p_capability: "billing_admin",
    }),
    callUntypedRpc("current_user_has_aal2"),
  ]);

  const capability = ensureData(
    capabilityResult.data,
    capabilityResult.error,
  );
  const aal2 = ensureData(aal2Result.data, aal2Result.error);

  return {
    hasCapability: requireBoolean(
      capability,
      "Commercial admin capability response",
    ),
    hasAal2: requireBoolean(aal2, "Commercial admin AAL2 response"),
  };
}
