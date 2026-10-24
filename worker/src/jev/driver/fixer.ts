import { z } from "zod";
import { normalizeLabel } from "../../fixtureHeal/fingerprint.js";
import { POLICY_REVISION } from "./policy.js";
import { SNAPSHOT_REVISION } from "./snapshot.js";
import { DRIVER_REVISION, type ConfigField, type DriverField, type DriverOutcome, type LocatorCandidate, type StopReason } from "./types.js";

/**
 * The fixer (§17): turns a verified driven run into a `driven_locator_candidate.v1`
 * repair payload. A completed run carries stable-locator candidates that
 * resolved to exactly one visible element, the verified node, plus a
 * structural skeleton; a stopped run carries only a diagnostic. The worker
 * never touches git: the payload is a `repair_adapter_candidate` task result
 * that an engineering agent turns into a draft PR for human review.
 */
export const DRIVEN_LOCATOR_CANDIDATE_SCHEMA = "driven_locator_candidate.v1";
export const SKELETON_HEADER = "<!-- GENERATED STRUCTURAL SKELETON – synthetic values – review before commit -->";
const MAX_SKELETON_CHARS = 4_096;
const STABLE_TEST_ID = /^[A-Za-z][A-Za-z0-9_-]{1,63}$/;
const STABLE_ATTRIBUTE = /^[A-Za-z][A-Za-z0-9_-]{2,40}$/;

export function isStableTestId(value: string) {
  return STABLE_TEST_ID.test(value) && !/\d{4,}/.test(value) && !/[0-9a-f]{8,}/i.test(value);
}

function isStableAttribute(value: string) {
  return STABLE_ATTRIBUTE.test(value) && !/(?:^(?::r|r\d))|(?:react-select)|(?:\d{3,})/.test(value);
}

/** Every quoted string in a candidate must be a reviewed phrase or a stable token; anything else is dropped. */
export function acceptLocatorCandidate(candidate: LocatorCandidate, vocabulary: ReadonlySet<string>) {
  const { selector } = candidate;
  if (selector.length > 300) return false;
  const quoted = [...selector.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((match) => match[1]);
  const token = (value: string) => /^[a-z-]{1,24}$/i.test(value);
  /** Attribute tokens (`[type="text"]`, `[role="combobox"]`) only; human-readable text must be a reviewed phrase. */
  const textual = (pattern: RegExp) => [...selector.matchAll(pattern)].map((match) => match[1]);
  switch (candidate.kind) {
    case "test_id":
      return quoted.length >= 1 && isStableTestId(quoted[0]) && quoted.slice(1).every(token);
    case "role": {
      const names = textual(/\[name="((?:[^"\\]|\\.)*)"s?\]/g);
      return names.length === 1 && vocabulary.has(normalizeLabel(names[0])) && quoted.length === 1;
    }
    case "label_anchor": {
      const labels = textual(/:text-is\("((?:[^"\\]|\\.)*)"\)/g);
      return labels.length === 1 && vocabulary.has(normalizeLabel(labels[0])) && quoted.filter((value) => value !== labels[0]).every(token);
    }
    case "stable_attribute": {
      const id = /^#([A-Za-z0-9_-]+)$/.exec(candidate.selector)?.[1];
      return id ? isStableAttribute(id) : quoted.length === 1 && isStableAttribute(quoted[0]);
    }
  }
}

export type DrivenLocatorCandidate = {
  schema: typeof DRIVEN_LOCATOR_CANDIDATE_SCHEMA;
  vendor: string;
  routeClass: string;
  outcome: "completed" | "stopped";
  stop: { reason: StopReason; field: DriverField | null } | null;
  fields: Array<{ field: ConfigField; target: string; insertIndex: 0; candidates: Array<{ kind: LocatorCandidate["kind"]; selector: string }>; skeleton: string | null }>;
  revisions: { driver: string; policy: string; snapshot: string; binding: string };
  vocabularyDigest: string;
  counts: { modelCalls: number; actions: number; inputTokens: number };
};

export function buildDrivenLocatorCandidate(input: {
  vendor: string;
  routeClass: string;
  outcome: DriverOutcome;
  /** Locator constant each field's candidate belongs ahead of, e.g. `quantityInputs`. */
  targets: Readonly<Record<ConfigField, string>>;
  vocabulary: ReadonlySet<string>;
  bindingRevision: string;
}): DrivenLocatorCandidate {
  const { outcome } = input;
  const fields: DrivenLocatorCandidate["fields"] = [];
  if (outcome.status === "completed") {
    const byField = new Map<ConfigField, LocatorCandidate[]>();
    for (const candidate of outcome.candidates) {
      if (!acceptLocatorCandidate(candidate, input.vocabulary)) continue;
      byField.set(candidate.field, [...(byField.get(candidate.field) ?? []), candidate]);
    }
    for (const [field, candidates] of byField) {
      const skeleton = outcome.skeletons[field];
      fields.push({
        field, target: input.targets[field], insertIndex: 0,
        candidates: candidates.map(({ kind, selector }) => ({ kind, selector })),
        skeleton: skeleton && skeleton.length + SKELETON_HEADER.length < MAX_SKELETON_CHARS ? `${SKELETON_HEADER}\n${skeleton}` : null,
      });
    }
  }
  return {
    schema: DRIVEN_LOCATOR_CANDIDATE_SCHEMA, vendor: input.vendor, routeClass: input.routeClass, outcome: outcome.status,
    stop: outcome.status === "stopped" ? { reason: outcome.reason, field: outcome.field } : null,
    fields,
    revisions: { driver: DRIVER_REVISION, policy: POLICY_REVISION, snapshot: SNAPSHOT_REVISION, binding: input.bindingRevision },
    vocabularyDigest: outcome.summary.vocabularyDigest,
    counts: { modelCalls: outcome.summary.modelCalls, actions: outcome.summary.actions, inputTokens: outcome.summary.inputTokens },
  };
}

const candidateSchema = z.object({
  schema: z.literal(DRIVEN_LOCATOR_CANDIDATE_SCHEMA),
  vendor: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/),
  routeClass: z.string().regex(/^[a-z_]{1,40}$/),
  outcome: z.enum(["completed", "stopped"]),
  stop: z.object({ reason: z.string().regex(/^[a-z_]{1,40}$/), field: z.string().regex(/^[a-z_]{1,20}$/).nullable() }).nullable(),
  fields: z.array(z.object({
    field: z.enum(["process", "material", "finish", "quantity"]),
    target: z.string().regex(/^[A-Za-z]{1,40}$/),
    insertIndex: z.literal(0),
    candidates: z.array(z.object({ kind: z.enum(["test_id", "role", "label_anchor", "stable_attribute"]), selector: z.string().max(300) })).max(8),
    skeleton: z.string().max(MAX_SKELETON_CHARS).nullable(),
  })).max(4),
  revisions: z.object({ driver: z.string().max(60), policy: z.string().max(60), snapshot: z.string().max(60), binding: z.string().max(60) }),
  vocabularyDigest: z.string().regex(/^[0-9a-f]{16}$/),
  counts: z.object({ modelCalls: z.number().int().nonnegative(), actions: z.number().int().nonnegative(), inputTokens: z.number().int().nonnegative() }),
});

/** Validates a stored repair payload before `handleRepairTask` keeps it as the task result. */
export function parseDrivenLocatorCandidate(payload: unknown): DrivenLocatorCandidate | null {
  const parsed = candidateSchema.safeParse(payload);
  return parsed.success ? (parsed.data as DrivenLocatorCandidate) : null;
}

/** The `repair_adapter_candidate` work-queue payload a host enqueues for a driven run. */
export function drivenRepairTaskPayload(candidate: DrivenLocatorCandidate) {
  return { vendor: candidate.vendor, failureCode: DRIVEN_LOCATOR_CANDIDATE_SCHEMA, drivenLocatorCandidate: candidate };
}
