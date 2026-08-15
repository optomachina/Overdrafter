export const FOUNDING_BETA_SUPPORT_EMAIL = "blaineswilson@gmail.com";

export type FoundingBetaAccessState =
  | "eligible"
  | "not_enrolled"
  | "notice_required"
  | "revoked";

export type FoundingBetaAccess = {
  state: FoundingBetaAccessState;
  policyRevision: string;
  termsPath: string;
  privacyPath: string;
};

export type FoundingBetaUploadStatus =
  | FoundingBetaAccessState
  | "loading"
  | "unavailable";

type FoundingBetaRefetchResult = {
  data?: Pick<FoundingBetaAccess, "state">;
  isError: boolean;
};

const ACCESS_STATES = new Set<FoundingBetaAccessState>([
  "eligible",
  "not_enrolled",
  "notice_required",
  "revoked",
]);

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message: unknown }).message;
    return typeof message === "string" ? message : "";
  }

  return "";
}

/** Converts the security-definer RPC response into the client access contract. */
export function parseFoundingBetaAccess(value: unknown): FoundingBetaAccess {
  if (!value || typeof value !== "object") {
    throw new Error("Founding Beta access could not be verified.");
  }

  const record = value as Record<string, unknown>;
  if (
    typeof record.state !== "string" ||
    !ACCESS_STATES.has(record.state as FoundingBetaAccessState) ||
    typeof record.policyRevision !== "string" ||
    typeof record.termsPath !== "string" ||
    typeof record.privacyPath !== "string"
  ) {
    throw new Error("Founding Beta access could not be verified.");
  }

  return {
    state: record.state as FoundingBetaAccessState,
    policyRevision: record.policyRevision,
    termsPath: record.termsPath,
    privacyPath: record.privacyPath,
  };
}

export function getFoundingBetaUploadMessage(status: FoundingBetaUploadStatus): string {
  switch (status) {
    case "eligible":
      return "";
    case "not_enrolled":
      return `Founding Beta invitation required to create new parts or upload files. Contact ${FOUNDING_BETA_SUPPORT_EMAIL} for access.`;
    case "revoked":
      return `New drafts and uploads are paused for this organization. Existing parts and quotes remain available. Contact ${FOUNDING_BETA_SUPPORT_EMAIL}.`;
    case "notice_required":
      return "Review and accept the current Founding Beta notice before creating a new part or uploading files.";
    case "loading":
      return "Checking Founding Beta new-part access. Please try again in a moment.";
    case "unavailable":
      return `Founding Beta new-part access could not be verified. Contact ${FOUNDING_BETA_SUPPORT_EMAIL} if this continues.`;
  }
}

/** Refetches may retain stale data after an error, so only a successful result is authoritative. */
export function getFoundingBetaStatusFromRefetch(
  result: FoundingBetaRefetchResult,
): FoundingBetaUploadStatus {
  if (result.isError || !result.data) {
    return "unavailable";
  }

  return result.data.state;
}

export function isFoundingBetaEnforcementError(error: unknown): boolean {
  const message = getErrorMessage(error);

  return /Founding Beta access and current notice acceptance are required/i.test(message) ||
    getFoundingBetaStatusFromError(error) !== null;
}

export function getFoundingBetaStatusFromError(error: unknown): FoundingBetaAccessState | null {
  const message = getErrorMessage(error);
  const match = /founding_beta_(not_enrolled|notice_required|revoked)/i.exec(message);
  const state = match?.[1]?.toLowerCase() as FoundingBetaAccessState | undefined;
  return state ?? null;
}
