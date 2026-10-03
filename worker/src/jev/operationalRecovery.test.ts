// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Page } from "patchright";
import { setQuantity } from "../adapters/xometry";
import { JEV_MODEL, type ChoiceQuestion } from "./choice";
import { OperationalJevSession, OperationalJevObservations, type OperationalJevBinding, type OperationalJevScope } from "./operationalSession";
vi.mock("camoufox-js", () => ({ launchOptions: vi.fn() }));
const scope: OperationalJevScope = { organizationId: "org", taskId: "task", quoteRunId: "run", provider: "xometry", sourceRevision: "a".repeat(40) };
beforeEach(() => {
  document.body.innerHTML = '<input type="number" aria-label="Quantity" value="1">';
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(function (this: HTMLElement) {
    return (this.hidden ? [] : [this.getBoundingClientRect()]) as unknown as DOMRectList;
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, width: 100, height: 10 } as DOMRect);
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => document.querySelector("input") });
});
afterEach(() => { document.body.innerHTML = ""; Reflect.deleteProperty(document, "elementFromPoint"); vi.restoreAllMocks(); vi.useRealTimers(); });
function fixture(options: { off?: boolean; denied?: boolean; profileDenied?: boolean; auditMutation?: boolean; late?: boolean; signal?: AbortSignal } = {}) {
  const appearedHtml = '<input type="number" aria-label="Quantity" value="1">';
  document.body.innerHTML = "";
  let appeared = false;
  const fill = vi.fn(), selectOption = vi.fn(), press = vi.fn(), dispose = vi.fn(async () => undefined);
  const evaluate = vi.fn(async (callback, args) => callback({ ...args, nodes: args.nodes.map((handle: { node: Element }) => handle.node) }));
  const elementHandles = vi.fn(async () => Array.from(document.querySelectorAll("input")).map((node) => ({ node, fill, selectOption, dispose })));
  const page = { url: () => "https://www.xometry.com/quoting/quote/Q26-SYNTHETIC", evaluate,
    locator: (selector: string) => ({ first: () => ({ count: async () => {
        const count = document.querySelectorAll(selector).length;
        // The final declared baseline selector is already the generic native number
        // selector. Only a control arriving AFTER that read can reach this source hook.
        if (selector === 'input[type="number"]' && count === 0 && !appeared) {
          appeared = true;
          queueMicrotask(() => { document.body.innerHTML = appearedHtml; });
        }
        return count;
      }, fill, press }),
      count: async () => document.querySelectorAll(selector).length, elementHandles,
      innerText: async () => "Configure part quantity" }) } as unknown as Page;
  const caps = { authorize: vi.fn(async () => !options.denied), reserve: vi.fn(async () => ({ reservationId: "one", estimatedUsd: 0.1 })),
    settle: vi.fn(async () => undefined), audit: vi.fn(async (receipt) => {
      if (options.auditMutation && receipt.recoveryOutcome === "proposed") document.querySelector("input")!.replaceWith(document.createElement("input"));
      return true;
    }), decide: vi.fn(async (question: ChoiceQuestion) => {
      if (options.late) await new Promise(() => undefined);
      return { model: JEV_MODEL, choice: "c0", confidence: 1, inputTokens: 10, outputTokens: 5,
        probabilities: Object.fromEntries(Object.keys(question.criteria).map((key) => [key, key === "c0" ? 1 : 0])) };
    }) };
  const session = new OperationalJevSession(options.off ? { mode: "off" } : { mode: "shadow", capabilities: caps, signal: options.signal,
    admission: { scope, expiresAt: Date.now() + 60000, uses: ["recovery"], evidenceProfiles: options.profileDenied ? [] : ["recovery_labels.v1"] } });
  const binding: OperationalJevBinding = { session, scope, observations: new OperationalJevObservations(), freshBrowserRecovery: "bounded_observation" };
  const attempt = () => setQuantity(page, 2, binding);
  return { attempt, page, binding, caps, fill, selectOption, press, evaluate, elementHandles, appearedHtml };
}
describe("actual Xometry missing-quantity source branch", () => {
  it("observes a native control arriving after the final baseline read without recovering or changing its value", async () => {
    const baselineFixture = fixture();
    const baseline = await setQuantity(baselineFixture.page, 2).catch((error) => error);
    const test = fixture();
    const error = await test.attempt().catch((error) => error);
    expect({ message: error.message, code: error.code, payload: error.payload }).toEqual({ message: baseline.message, code: baseline.code, payload: baseline.payload });
    expect(test.binding.observations.localReview().get("recovery")).toMatchObject({ outcome: "observed", recoveryOutcome: "proposed" });
    expect(test.caps.decide).toHaveBeenCalledOnce(); expect(document.body.innerHTML).toBe(test.appearedHtml);
    expect(test.fill).not.toHaveBeenCalled(); expect(test.press).not.toHaveBeenCalled(); expect(test.selectOption).not.toHaveBeenCalled();
    expect(test.caps.settle).not.toHaveBeenCalled();
    expect(test.caps.audit.mock.calls.filter(([r]) => r.recoveryOutcome === "proposed")).toHaveLength(1);
  });
  it.each([{ off: true }, { profileDenied: true }])("off/denied data profile adds no DOM observations: %j", async (options) => {
    const test = fixture(options); await expect(test.attempt()).rejects.toMatchObject({ code: "selector_failure" });
    expect(test.evaluate).not.toHaveBeenCalled(); expect(test.elementHandles).not.toHaveBeenCalled(); expect(test.caps.authorize).not.toHaveBeenCalled();
  });
  it("authorization denial starts no DOM observation, reservation or inference", async () => {
    const test = fixture({ denied: true }); await expect(test.attempt()).rejects.toMatchObject({ code: "selector_failure" });
    expect(test.evaluate).not.toHaveBeenCalled(); expect(test.caps.reserve).not.toHaveBeenCalled(); expect(test.caps.decide).not.toHaveBeenCalled();
  });
  it("rechecks freshness after final durable proposed audit", async () => {
    const test = fixture({ auditMutation: true }); await expect(test.attempt()).rejects.toMatchObject({ code: "selector_failure" });
    expect(test.binding.observations.localReview().get("recovery")).toMatchObject({ outcome: "unavailable" });
    expect(test.fill).not.toHaveBeenCalled();
  });
  it.each(["cancel", "deadline"])("bounds a pending model at %s and retains original error", async (reason) => {
    vi.useFakeTimers(); const controller = new AbortController(); const test = fixture({ late: true, signal: controller.signal });
    const pending = test.attempt(); const checked = expect(pending).rejects.toMatchObject({ code: "selector_failure" });
    await vi.advanceTimersByTimeAsync(1); expect(test.caps.decide).toHaveBeenCalledOnce();
    if (reason === "cancel") controller.abort(); else await vi.advanceTimersByTimeAsync(6000);
    await checked; expect(test.fill).not.toHaveBeenCalled(); expect(test.caps.settle).not.toHaveBeenCalled();
  });
  it("does not replay a cached proposal as fresh for a later missing target or field", async () => {
    const test = fixture(); await expect(test.attempt()).rejects.toMatchObject({ code: "selector_failure" });
    expect(test.binding.observations.localReview().get("recovery")).toMatchObject({ recoveryOutcome: "proposed" });
    document.body.innerHTML = '<button aria-label="Quantity">Unsupported</button>';
    const reads = test.evaluate.mock.calls.length;
    await expect(test.attempt()).rejects.toMatchObject({ code: "selector_failure" });
    expect(test.binding.observations.localReview().get("recovery")).toMatchObject({ outcome: "unavailable", recoveryOutcome: "unavailable" });
    expect(test.caps.decide).toHaveBeenCalledOnce(); expect(test.evaluate).toHaveBeenCalledTimes(reads);
    const receipt = await test.binding.session.recovery(scope, { page: test.page as unknown as import("playwright").Page,
      field: "material", operation: "select", value: "private", assertBoundary: vi.fn(), assertReady: vi.fn(), beforeMutation: vi.fn() });
    expect(receipt).toMatchObject({ outcome: "unavailable", recoveryOutcome: "unavailable" });
    expect(test.caps.decide).toHaveBeenCalledOnce();
  });

});
