import { recordBoundedAudit } from "./boundedAudit.js";
import { createHash } from "node:crypto";
import type { ElementHandle, Page } from "playwright";
import { validateRecoveryDecision, type RecoveryDecider, type RecoveryField, type RecoveryQuestion } from "./jevDecision.js";

export type RecoveryAudit = {
  revision: "bounded-browser-recovery.v1";
  attempt: number;
  field: RecoveryField;
  outcome: "action_planned" | "recovered" | "proposal_planned" | "proposed" | "no_candidates" | "ambiguous" | "abstained" | "invalid_decision" | "stale" | "budget" | "cancelled" | "unavailable" | "action_uncertain";
  observationHash: string | null;
  candidateCount: number;
  selectedId: string | null;
  elapsedMs: number;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
};
export type BrowserRecoveryOptions = {
  enabled: true;
  decide: RecoveryDecider;
  signal?: AbortSignal;
  /** Must durably record the bounded receipt; never receives DOM text or errors. */
  audit: (event: RecoveryAudit) => Promise<void>;
};

export type BrowserRecoveryInput = {
  page: Page; field: string; operation: "fill" | "select"; value: string;
  assertBoundary: () => void;
  assertReady: () => Promise<void>;
  beforeMutation: () => void;
};
export type BrowserRecoveryShadowResult = {
  mode: "shadow";
  /** Observation never satisfies the caller's failed configuration operation. */
  recovered: false;
  proposed: boolean;
  receipt: RecoveryAudit | null;
};

type Control = { label: string; control: "number" | "select"; fingerprint: string };
const compatible: Record<RecoveryField, RegExp> = {
        quantity: /^(quantity|qty|part quantity|number of parts)( \/ (quantity|qty|part quantity|number of parts))*$/,
        material: /^(material|part material)( \/ (material|part material))*$/,
        finish: /^(finish|surface finish)( \/ (finish|surface finish))*$/,
        thickness: /^(thickness|sheet thickness)( \/ (thickness|sheet thickness))*$/,
};

const FIELD_NAMES = new Set(["quantity", "material", "finish", "thickness"]);

/** Deliberately small vocabulary: unknown/private/hostile labels never leave the browser. */
async function describeAll(page: Page, handles: ElementHandle[], operation: "fill" | "select", value: string): Promise<Array<Control | null> | null> {
  return page.evaluate(({ nodes, operation, value }) => {
    const current = Array.from(document.querySelectorAll(operation === "fill" ? 'input[type="number"]' : "select"));
    if (current.length !== nodes.length || nodes.some((node, index) => !node.isConnected || node !== current[index])) return null;
    // Identities, visibility, labels, eligibility and fingerprints share one browser turn.
    return nodes.map((node) => {
    const element = node as HTMLInputElement | HTMLSelectElement;
    if (!element.isConnected || element.disabled || element.getClientRects().length === 0
      || getComputedStyle(element).visibility !== "visible") return null;
    if (element.hasAttribute("aria-labelledby")) return null;
    const rect = element.getBoundingClientRect();
    const x = rect.x + rect.width / 2;
    const y = rect.y + rect.height / 2;
    if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight || document.elementFromPoint(x, y) !== element) return null;
    const labels = Array.from(element.labels ?? []).map((label) => label.textContent ?? "");
    const raw = [element.getAttribute("aria-label"), ...labels, element.getAttribute("name")].filter(Boolean) as string[];
    const vocabulary: Record<string, string> = {
      quantity: "quantity", qty: "qty", "part quantity": "part quantity", "number of parts": "number of parts",
      material: "material", "part material": "part material", finish: "finish", "surface finish": "surface finish",
      thickness: "thickness", "sheet thickness": "sheet thickness",
    };
    // Reject entire labels rather than guessing how to redact arbitrary private text.
    if (!raw.length || raw.some((text) => !Object.hasOwn(vocabulary, text.trim().toLowerCase()))) return null;
    const label = raw.map((text) => vocabulary[text.trim().toLowerCase()]).join(" / ");
    let control: "number" | "select";
    if (operation === "fill") {
      if (element.tagName !== "INPUT" || (element as HTMLInputElement).type !== "number"
        || (element as HTMLInputElement).readOnly || !/^\d{1,9}$/.test(value)
        || Number(value) < 1) return null;
      control = "number";
    } else {
      if (element.tagName !== "SELECT" || (element as HTMLSelectElement).multiple) return null;
      const options = Array.from((element as HTMLSelectElement).options);
      if (options.filter((option) => option.value === value && !option.disabled
        && !(option.parentElement instanceof HTMLOptGroupElement && option.parentElement.disabled)).length !== 1) return null;
      control = "select";
    }
    // Kept local, never transmitted or audited. Includes state and option mutations.
    const fingerprint = JSON.stringify([element.outerHTML, element.value, labels]);
    return { label, control, fingerprint };
    });
  }, { nodes: handles, operation, value });
}

/** One session owns two decisions/actions at most. A failed/uncertain action exhausts it permanently. */
export function createBrowserRecovery(options: BrowserRecoveryOptions) {
  const recover = createRecoveryExecutor(options, "action");
  return async (input: BrowserRecoveryInput): Promise<boolean> => (await recover(input)).succeeded;
}

/** Explicit observation-only session; a proposal grants no mutation or selector-repair authority. */
export function createBrowserRecoveryShadow(options: BrowserRecoveryOptions) {
  const observe = createRecoveryExecutor(options, "shadow");
  return async (input: BrowserRecoveryInput): Promise<BrowserRecoveryShadowResult> => {
    const result = await observe(input);
    return { mode: "shadow", recovered: false, proposed: result.succeeded, receipt: result.receipt };
  };
}

function createRecoveryExecutor(options: BrowserRecoveryOptions, mode: "action" | "shadow") {
  let attempts = 0;
  let exhausted = false;
  let active = false;
  let tokenTotal = 0;
  return async (input: BrowserRecoveryInput): Promise<{ succeeded: boolean; receipt: RecoveryAudit | null }> => {
    if (!FIELD_NAMES.has(input.field)) return { succeeded: false, receipt: null };
    const field = input.field as RecoveryField;
    const started = performance.now();
    const deadline = started + 5_000;
    const receipt: RecoveryAudit = {
      revision: "bounded-browser-recovery.v1", attempt: attempts + 1, field,
      outcome: "unavailable", observationHash: null, candidateCount: 0, selectedId: null,
      elapsedMs: 0, model: null, inputTokens: null, outputTokens: null,
    };
    const record = async () => {
      receipt.elapsedMs = performance.now() - started;
      if (!await recordBoundedAudit(() => options.audit(structuredClone(receipt)))) throw new Error("recovery_audit_unavailable");
    };
    if (active || exhausted || attempts >= 2 || tokenTotal >= 4_000) {
      receipt.outcome = "budget"; await record(); return { succeeded: false, receipt };
    }
    active = true;
    attempts += 1;
    const controller = new AbortController();
    const cancel = () => controller.abort();
    const expire = () => { if (performance.now() >= deadline) cancel(); };
    options.signal?.addEventListener("abort", cancel, { once: true });
    if (options.signal?.aborted) cancel();
    const timer = setTimeout(cancel, 5_000);
    const handles: ElementHandle[] = [];
    const recheckedHandles: ElementHandle[] = [];
    let mutationStarted = false;
    let auditFailed = false;
    let shadowProposalAudited = false;
    const perform = async (): Promise<boolean> => {
    try {
      const check = () => {
        expire(); controller.signal.throwIfAborted();
        input.assertBoundary();
        expire(); controller.signal.throwIfAborted();
      };
      const bounded = async <T>(operation: () => Promise<T>): Promise<T> => {
        check();
        let rejectAbort: (() => void) | undefined;
        const cancelled = new Promise<never>((_, reject) => {
          rejectAbort = () => reject(new Error("cancelled"));
          controller.signal.addEventListener("abort", rejectAbort, { once: true });
        });
        try {
          const result = await Promise.race([cancelled, operation()]);
          check();
          return result;
        }
        finally { if (rejectAbort) controller.signal.removeEventListener("abort", rejectAbort); }
      };
      check();
      await bounded(input.assertReady);
      check();
      if ((field === "quantity") !== (input.operation === "fill")) {
        receipt.outcome = "no_candidates"; return false;
      }
      const url = input.page.url();
      const locator = input.page.locator(input.operation === "fill" ? 'input[type="number"]' : "select");
      if (await bounded(() => locator.count()) > 16) { receipt.outcome = "budget"; return false; }
      handles.push(...await bounded(() => locator.elementHandles()));
      if (handles.length > 16) { receipt.outcome = "budget"; return false; }
      const observations = await bounded(() => describeAll(input.page, handles, input.operation, input.value));
      if (!observations) { receipt.outcome = "stale"; return false; }
      const candidates: Array<{ handle: ElementHandle; description: Control; id: string }> = [];
      for (const [index, description] of observations.entries()) {
        if (description) candidates.push({ handle: handles[index], description, id: `c${candidates.length}` });
      }
      receipt.candidateCount = candidates.length;
      if (!candidates.length) { receipt.outcome = "no_candidates"; return false; }
      if (new Set(candidates.map(({ description }) => description.label)).size !== candidates.length
        || candidates.filter(({ description }) => compatible[field].test(description.label)).length > 1) {
        receipt.outcome = "ambiguous"; return false;
      }
      const question: RecoveryQuestion = { field, candidates: candidates.map(({ id, description }) => ({
        id, label: description.label, control: description.control,
      })) };
      receipt.observationHash = createHash("sha256").update(JSON.stringify(question)).digest("hex");
      check();
      // Race bounds even an injected decider that ignores cancellation; it never gets an action capability.
      const decision = await bounded(() => options.decide(structuredClone(question), controller.signal));
      check();
      if (!validateRecoveryDecision(decision, question)) { receipt.outcome = "invalid_decision"; return false; }
      receipt.model = decision.model; receipt.inputTokens = decision.inputTokens; receipt.outputTokens = decision.outputTokens;
      tokenTotal += decision.inputTokens + decision.outputTokens;
      if (tokenTotal > 4_000) { receipt.outcome = "budget"; return false; }
      if (decision.choice === "abstain" || decision.confidence < 0.9 || decision.probabilities[decision.choice] < 0.95) {
        receipt.outcome = "abstained"; return false;
      }
      const selected = candidates.find(({ id }) => id === decision.choice)!;
      receipt.selectedId = selected.id;
      if (!compatible[field].test(selected.description.label)) { receipt.outcome = "invalid_decision"; return false; }
      receipt.outcome = mode === "shadow" ? "proposal_planned" : "action_planned";
      await bounded(record);
      const stillCurrent = async () => {
        await bounded(input.assertReady);
        const rechecked = await bounded(() => locator.elementHandles());
        recheckedHandles.push(...rechecked);
        if (rechecked.length !== handles.length) return false;
        if (input.page.url() !== url || await bounded(() => locator.count()) !== handles.length) return false;
        const current = await bounded(() => describeAll(input.page, handles, input.operation, input.value));
        return input.page.url() === url && current !== null && !current.some((description, index) =>
          (description?.fingerprint ?? null) !== (observations[index]?.fingerprint ?? null));
      };
      if (!await stillCurrent()) { receipt.outcome = "stale"; return false; }
      check();
      if (mode === "shadow") {
        receipt.outcome = "proposed";
        await bounded(record);
        // The audit sink is asynchronous: its completion must not bless stale evidence.
        if (!await stillCurrent()) { receipt.outcome = "stale"; return false; }
        check();
        shadowProposalAudited = true;
        return true;
      }
      mutationStarted = true;
      input.beforeMutation();
      if (input.operation === "fill") await bounded(() => selected.handle.fill(input.value, { timeout: 1_000 }));
      else await bounded(() => selected.handle.selectOption(input.value, { timeout: 1_000 }));
      check();
      if (await bounded(() => selected.handle.inputValue({ timeout: 1_000 })) !== input.value) throw new Error("value_not_applied");
      receipt.outcome = "recovered";
      return true;
    } catch {
      receipt.outcome = "unavailable";
      if (mutationStarted) receipt.outcome = "action_uncertain";
      else if (controller.signal.aborted) receipt.outcome = "cancelled";
      return false;
    } finally {
      if (receipt.outcome !== "recovered" && receipt.outcome !== "proposed") exhausted = true;
      // Context closure owns final cleanup; disposal must not defeat the attempt deadline.
      void Promise.all([...handles, ...recheckedHandles].map((handle) => handle.dispose().catch(() => undefined)));
      receipt.elapsedMs = performance.now() - started;
      expire();
      if (!shadowProposalAudited && !await recordBoundedAudit(() => options.audit(structuredClone(receipt)))) {
        exhausted = true;
        auditFailed = true;
      }
      expire();
    }
    };
    const recovered = await perform();
    expire();
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancel);
    active = false;
    if (controller.signal.aborted) {
      exhausted = true;
      if (mutationStarted) throw new Error("recovery_cancelled_after_mutation");
      if (mode === "shadow") receipt.outcome = "cancelled";
      return { succeeded: false, receipt };
    }
    if (auditFailed && mutationStarted) throw new Error("recovery_audit_unavailable");
    if (mode === "shadow" && auditFailed) {
      receipt.outcome = "unavailable";
      return { succeeded: false, receipt };
    }
    return { succeeded: recovered, receipt };
  };
}
