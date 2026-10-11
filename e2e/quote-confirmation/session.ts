/** Authentication is an explicitly synthetic boundary; never reads saved sessions. */
import { ID } from "./data";
const session = {
  user: { id: ID.actor, email: "quote-fixture@example.invalid", user_metadata: {} },
  activeMembership: { organizationId: ID.organization, organizationName: "Synthetic Free organization", role: "client" },
  isVerifiedAuth: true, isAuthInitializing: false, isPlatformAdmin: false,
  signOut: async () => { throw new Error("Sign-out is outside this fixture"); },
};
export const useAppSession = () => session;
