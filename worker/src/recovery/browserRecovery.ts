import { createHash } from "node:crypto";
import type { ElementHandle, Page } from "playwright";
import { validateRecoveryDecision, type RecoveryDecider, type RecoveryField, type RecoveryQuestion } from "./jevDecision.js";

export type RecoveryAudit = {
  revision: "bounded-browser-recovery.v1";
  attempt: number;
  field: RecoveryField;
  outcome: "recovered" | "no_candidates" | "ambiguous" | "abstained" | "invalid_decision" | "stale" | "budget" | "cancelled" | "unavailable" | "action_uncertain";
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

type Control = { label: string; control: "number" | "select"; fingerprint: string };
const FIELD_NAMES = new Set(["quantity", "material", "finish", "thickness"]);

/** Deliberately small vocabulary: unknown/private/hostile labels never leave the browser. */
async function describe(handle: ElementHandle, operation: "fill" | "select", value: string): Promise<Control | null> {
  return handle.evaluate((node, args) => {
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
    if (args.operation === "fill") {
      if (element.tagName !== "INPUT" || (element as HTMLInputElement).type !== "number"
        || (element as HTMLInputElement).readOnly || !/^\d{1,9}$/.test(args.value)
        || Number(args.value) < 1) return null;
      control = "number";
    } else {
      if (element.tagName !== "SELECT" || (element as HTMLSelectElement).multiple) return null;
      const options = Array.from((element as HTMLSelectElement).options);
      if (options.filter((option) => option.value === args.value && !option.disabled
        && !(option.parentElement instanceof HTMLOptGroupElement && option.parentElement.disabled)).length !== 1) return null;
      control = "select";
    }
    // Kept local, never transmitted or audited. Includes state and option mutations.
    const fingerprint = JSON.stringify([element.outerHTML, element.value, labels]);
    return { label, control, fingerprint };
  }, { operation, value });
}

/** One session owns two decisions/actions at most. A failed/uncertain action exhausts it permanently. */
export function createBrowserRecovery(options: BrowserRecoveryOptions) {
  let attempts = 0;
  let exhausted = false;
  let active = false;
  let tokenTotal = 0;
  return async (input: {
    page: Page; field: string; operation: "fill" | "select"; value: string;
    assertBoundary: () => void;
    assertReady: () => Promise<void>;
    beforeMutation: () => void;
  }): Promise<boolean> => {
    if (!FIELD_NAMES.has(input.field)) return false;
    const field = input.field as RecoveryField;
    const started = performance.now();
    const receipt: RecoveryAudit = {
      revision: "bounded-browser-recovery.v1", attempt: attempts + 1, field,
      outcome: "unavailable", observationHash: null, candidateCount: 0, selectedId: null,
      elapsedMs: 0, model: null, inputTokens: null, outputTokens: null,
    };
    const record = async () => { receipt.elapsedMs = performance.now() - started; await options.audit(receipt); };
    if (active || exhausted || attempts >= 2 || tokenTotal >= 4_000) {
      receipt.outcome = "budget"; await record(); return false;
    }
    active = true;
    attempts += 1;
    const controller = new AbortController();
    const cancel = () => controller.abort();
    options.signal?.addEventListener("abort", cancel, { once: true });
    if (options.signal?.aborted) cancel();
    const timer = setTimeout(cancel, 5_000);
    const handles: ElementHandle[] = [];
    let mutationStarted = false;
    try {
      const check = () => { controller.signal.throwIfAborted(); input.assertBoundary(); };
      check();
      await input.assertReady();
      check();
      if ((field === "quantity") !== (input.operation === "fill")) {
        receipt.outcome = "no_candidates"; return false;
      }
      const url = input.page.url();
      const locator = input.page.locator(input.operation === "fill" ? 'input[type="number"]' : "select");
      if (await locator.count() > 16) { receipt.outcome = "budget"; return false; }
      handles.push(...await locator.elementHandles());
      if (handles.length > 16) { receipt.outcome = "budget"; return false; }
      const candidates: Array<{ handle: ElementHandle; description: Control; id: string }> = [];
      for (const handle of handles) {
        check();
        const description = await describe(handle, input.operation, input.value);
        if (description) candidates.push({ handle, description, id: `c${candidates.length}` });
      }
      receipt.candidateCount = candidates.length;
      if (!candidates.length) { receipt.outcome = "no_candidates"; return false; }
      if (new Set(candidates.map(({ description }) => description.label)).size !== candidates.length) {
        receipt.outcome = "ambiguous"; return false;
      }
      const question: RecoveryQuestion = { field, candidates: candidates.map(({ id, description }) => ({
        id, label: description.label, control: description.control,
      })) };
      receipt.observationHash = createHash("sha256").update(JSON.stringify(question)).digest("hex");
      check();
      // Race bounds even an injected decider that ignores cancellation; it never gets an action capability.
      const cancelled = new Promise<never>((_, reject) => {
        controller.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
      });
      const decision = await Promise.race([cancelled, options.decide(structuredClone(question), controller.signal)]);
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
      const compatible: Record<RecoveryField, RegExp> = {
        quantity: /^(quantity|qty|part quantity|number of parts)( \/ (quantity|qty|part quantity|number of parts))*$/,
        material: /^(material|part material)( \/ (material|part material))*$/,
        finish: /^(finish|surface finish)( \/ (finish|surface finish))*$/,
        thickness: /^(thickness|sheet thickness)( \/ (thickness|sheet thickness))*$/,
      };
      if (!compatible[field].test(selected.description.label)) { receipt.outcome = "invalid_decision"; return false; }
      await input.assertReady();
      check();
      for (const candidate of candidates) {
        const current = await describe(candidate.handle, input.operation, input.value);
        if (!current || current.fingerprint !== candidate.description.fingerprint) { receipt.outcome = "stale"; return false; }
      }
      if (input.page.url() !== url || await locator.count() !== handles.length) { receipt.outcome = "stale"; return false; }
      check();
      mutationStarted = true;
      input.beforeMutation();
      if (input.operation === "fill") await selected.handle.fill(input.value, { timeout: 1_000 });
      else await selected.handle.selectOption(input.value, { timeout: 1_000 });
      check();
      if (await selected.handle.inputValue() !== input.value) throw new Error("value_not_applied");
      receipt.outcome = "recovered";
      return true;
    } catch {
      if (mutationStarted) receipt.outcome = "action_uncertain";
      else if (controller.signal.aborted) receipt.outcome = "cancelled";
      return false;
    } finally {
      if (receipt.outcome !== "recovered") exhausted = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", cancel);
      await Promise.all(handles.map((handle) => handle.dispose().catch(() => undefined)));
      active = false;
      await record();
    }
  };
}
