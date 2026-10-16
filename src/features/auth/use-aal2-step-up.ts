import { useRef, useState } from "react";
import { hasAal2Session, listTotpFactors } from "@/features/auth/mfa-api";

export const STEP_UP_CANCELLED_MESSAGE =
  "Authenticator verification was cancelled. Nothing was changed.";
export const STEP_UP_ENROLL_MESSAGE =
  "Your account has no authenticator app enrolled, so this change cannot be verified. Nothing was changed. "
  + "Enroll one here with “Set up authenticator” (the same authenticator protects Commercial accounts and "
  + "Founding Beta changes), then submit the change again.";

export const STEP_UP_ENROLL_TITLE = "Set up an authenticator app";

export type StepUpNotice = { kind: "cancelled" | "enroll"; message: string };

type DialogMode = "verify" | "enroll";

/**
 * Gates an admin write on an AAL2 session (OVD-771).
 *
 * - AAL2: the write is sent at once.
 * - AAL1 with a verified authenticator: the intent is held and
 *   MfaStepUpDialog runs challenge and verify; the write is then sent exactly
 *   once. A failed write is reported by the caller's mutation and is not
 *   retried from the dialog.
 * - AAL1 with no verified authenticator: nothing is held or sent; an enroll
 *   notice says where to enroll, and startEnrollment opens the dialog for
 *   enrollment only.
 * - Cancel: the intent is dropped and no RPC is sent.
 *
 * If the assurance level or the factor list cannot be read, the challenge is
 * shown: failing closed costs a code entry, never an unverified write.
 */
export function useAal2StepUp<TIntent>(perform: (intent: TIntent) => Promise<unknown>) {
  const pendingRef = useRef<{ intent: TIntent } | null>(null);
  const verifiedRef = useRef(false);
  const [dialogMode, setDialogMode] = useState<DialogMode | null>(null);
  const [isCheckingAssurance, setIsCheckingAssurance] = useState(false);
  const [notice, setNotice] = useState<StepUpNotice | null>(null);

  const requestWrite = async (intent: TIntent) => {
    setNotice(null);
    setIsCheckingAssurance(true);
    let alreadyAal2 = false;
    let hasVerifiedFactor = true;

    try {
      alreadyAal2 = await hasAal2Session().catch(() => false);
      if (!alreadyAal2) {
        hasVerifiedFactor = await listTotpFactors().then(
          (factors) => factors.some((factor) => factor.status === "verified"),
          () => true,
        );
      }
    } finally {
      setIsCheckingAssurance(false);
    }

    if (alreadyAal2) {
      // The caller's mutation reports its own error.
      await perform(intent).catch(() => undefined);
      return;
    }

    if (!hasVerifiedFactor) {
      setNotice({ kind: "enroll", message: STEP_UP_ENROLL_MESSAGE });
      return;
    }

    pendingRef.current = { intent };
    setDialogMode("verify");
  };

  const startEnrollment = () => {
    pendingRef.current = null;
    setDialogMode("enroll");
  };

  const onOpenChange = (open: boolean) => {
    if (open) {
      return;
    }

    if (pendingRef.current) {
      pendingRef.current = null;
      setNotice({ kind: "cancelled", message: STEP_UP_CANCELLED_MESSAGE });
    } else if (verifiedRef.current) {
      // Enrollment finished (or the write was sent): the enroll notice is stale.
      setNotice(null);
    }

    verifiedRef.current = false;
    setDialogMode(null);
  };

  const onVerified = async () => {
    const pending = pendingRef.current;
    // Taken before the write so a second verify can never send it again.
    pendingRef.current = null;
    verifiedRef.current = true;

    if (pending) {
      await perform(pending.intent).catch(() => undefined);
    }
  };

  return {
    requestWrite,
    startEnrollment,
    isMfaOpen: dialogMode !== null,
    isCheckingAssurance,
    notice,
    dialogMode,
    dialogProps: { open: dialogMode !== null, onOpenChange, onVerified },
  };
}
