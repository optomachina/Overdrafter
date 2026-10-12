/**
 * OVD-723 export-control declaration, client side.
 *
 * Every upload needs an explicit answer before any file byte leaves the
 * browser. Only `not_controlled` continues; `controlled`, `unsure`, a dismissed
 * prompt, or no prompt at all stops the upload. The server repeats the check
 * (docs/migration-drafts/ovd-723.sql): the upload RPCs and the job-files
 * storage policy reject an upload without a clean declaration.
 */

/** Must equal `private.export_control_terms_version()` in the SQL draft. */
export const EXPORT_CONTROL_TERMS_VERSION = "ovd-beta-export-control.v1";

export const EXPORT_CONTROL_HELP_PATH = "/legal/terms";

export type ExportControlAnswer = "not_controlled" | "controlled" | "unsure";

export type ExportControlUploadBlockReason =
  | "export_declaration_missing"
  | "export_declaration_not_clean"
  | "export_declaration_stale"
  | "export_review_pending";

export const EXPORT_CONTROL_ANSWER_OPTIONS: ReadonlyArray<{
  value: ExportControlAnswer;
  label: string;
  description: string;
}> = [
  {
    value: "not_controlled",
    label: "Not export-controlled",
    description: "EAR99 or not subject to the EAR, and not ITAR. No CUI or distribution-limited technical data.",
  },
  {
    value: "controlled",
    label: "Export-controlled",
    description: "ITAR, an EAR classification other than EAR99, CUI, or a limiting distribution statement.",
  },
  {
    value: "unsure",
    label: "I'm not sure",
    description: "You have not confirmed the classification of these files.",
  },
];

const BLOCK_MESSAGES: Record<ExportControlUploadBlockReason, string> = {
  export_declaration_missing:
    "Upload stopped. Tell us whether these files are export-controlled before uploading.",
  export_declaration_not_clean:
    "Upload stopped. The OverDrafter beta does not accept ITAR, EAR-controlled (other than EAR99), CUI, or unconfirmed files. Nothing was uploaded.",
  export_declaration_stale:
    "Upload stopped. The export-control answer changed. Answer again, then retry the upload.",
  export_review_pending:
    "Upload stopped. This part is held for export-control review because its files carry export-control markings.",
};

export function getExportControlBlockMessage(reason: ExportControlUploadBlockReason): string {
  return BLOCK_MESSAGES[reason];
}

export function isExportControlUploadBlockReason(value: unknown): value is ExportControlUploadBlockReason {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(BLOCK_MESSAGES, value);
}

export class ExportControlUploadBlockedError extends Error {
  constructor(public readonly reasonCode: ExportControlUploadBlockReason) {
    super(getExportControlBlockMessage(reasonCode));
    this.name = "ExportControlUploadBlockedError";
  }
}

/** Only `not_controlled` is allowed; anything else (including unknown values) is blocked. */
export function evaluateExportControlAnswer(
  answer: unknown,
): { allowed: true; answer: "not_controlled" } | { allowed: false; reasonCode: ExportControlUploadBlockReason } {
  if (answer === "not_controlled") return { allowed: true, answer };
  if (answer === "controlled" || answer === "unsure") {
    return { allowed: false, reasonCode: "export_declaration_not_clean" };
  }
  return { allowed: false, reasonCode: "export_declaration_missing" };
}

export function isExportControlAnswer(value: unknown): value is ExportControlAnswer {
  return value === "not_controlled" || value === "controlled" || value === "unsure";
}

type ExportControlPrompter = () => Promise<ExportControlAnswer | null>;

let activePrompter: ExportControlPrompter | null = null;

/** Registered by the app-level declaration dialog host. Returns an unregister function. */
export function registerExportControlDeclarationPrompter(prompter: ExportControlPrompter): () => void {
  activePrompter = prompter;
  return () => {
    if (activePrompter === prompter) activePrompter = null;
  };
}

/**
 * Asks the user. With no registered prompter, or if the prompt fails, the
 * result is null, which the caller treats as a missing declaration.
 */
export async function requestExportControlAnswer(): Promise<ExportControlAnswer | null> {
  if (!activePrompter) return null;
  try {
    const answer = await activePrompter();
    return isExportControlAnswer(answer) ? answer : null;
  } catch {
    return null;
  }
}
