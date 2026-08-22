import type { XometryAuthProbeBaseEvidence } from "./xometryAuthProbe.js";

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
}) {
  const recoveryIdentity = await (async () => {
    try {
      return await input.loadRecoveryIdentity();
    } finally {
      await input.invalidateIdentity();
    }
  })();
  const interactive = await input.runInteractiveVerification(recoveryIdentity);
  const coldEvidence = await input.runColdRelaunchProof(interactive.identity);
  await input.promoteIdentity(interactive.identity);
  return { interactiveUrl: interactive.url, coldEvidence };
}
