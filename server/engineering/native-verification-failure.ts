export type NativeVerificationFailure = Readonly<{
  schema: "overdrafter.native-verification-failure.v1";
  code: "artifact_size_mismatch" | "artifact_digest_mismatch" | "native_evidence_rejected";
  reason: string;
  objectId: string | null;
  observedBytes: number | null;
  observedSha256: string | null;
}>;

/** A definite evidence rejection, distinct from admission or transport errors. */
export class NativeEvidenceRejection extends TypeError {
  readonly failure: NativeVerificationFailure;
  constructor(failure: Omit<NativeVerificationFailure, "schema">) {
    super(`Invalid stored native result: ${failure.reason}.`);
    this.name = "NativeEvidenceRejection";
    this.failure = Object.freeze({ ...failure, schema: "overdrafter.native-verification-failure.v1" });
  }
}

/** Preserve bounded internal predicate labels, never JSON parser excerpts. */
export function rejectedNativeReport(error: TypeError | SyntaxError): NativeEvidenceRejection {
  let reason = "Native evidence validation failed";
  if (error instanceof SyntaxError) reason = "Malformed JSON evidence";
  else {
    const label = error.message.replace(/^Invalid prepared evidence: /, "");
    if (/^[A-Za-z0-9 _.-]{1,160}$/.test(label)) reason = label;
  }
  return new NativeEvidenceRejection({ code: "native_evidence_rejected", reason,
    objectId: null, observedBytes: null, observedSha256: null });
}
