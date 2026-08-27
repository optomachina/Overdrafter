import type { XometryAuthProbeBaseEvidence } from "./xometryAuthProbe.js";
import type { Ovd410RecoveryPhase } from "./ovd410RecoveryPhase.js";

export type XometryRecoveryIdentity = Record<string, unknown>;

/**
 * Promote one recovered Camoufox identity only after interactive verification
 * and a separate closed-browser relaunch both succeed.
 */
export async function runVerifiedXometryCamoufoxRecovery(input: {
  loadRecoveryIdentity: () => Promise<XometryRecoveryIdentity | null>;
  invalidateIdentity: () => Promise<void>;
  runInteractiveVerification: (
    identity: XometryRecoveryIdentity | null,
  ) => Promise<{ identity: XometryRecoveryIdentity; url: string }>;
  runColdRelaunchProof: (
    identity: XometryRecoveryIdentity,
  ) => Promise<XometryAuthProbeBaseEvidence & { authenticated: true }>;
  promoteIdentity: (identity: XometryRecoveryIdentity) => Promise<void>;
  reportPhase?: (stage: Ovd410RecoveryPhase) => Promise<void>;
}) {
  const recoveryIdentity = await (async () => {
    try {
      return await input.loadRecoveryIdentity();
    } finally {
      await input.invalidateIdentity();
    }
  })();
  await input.reportPhase?.("profile-ready");
  await input.reportPhase?.("browser-launch");
  const interactive = await input.runInteractiveVerification(recoveryIdentity);
  await input.reportPhase?.("interactive-verified");
  await input.reportPhase?.("cold-relaunch");
  const coldEvidence = await input.runColdRelaunchProof(interactive.identity);
  await input.reportPhase?.("cold-verified");
  await input.promoteIdentity(interactive.identity);
  await input.reportPhase?.("identity-promoted");
  return { interactiveUrl: interactive.url, coldEvidence };
}
