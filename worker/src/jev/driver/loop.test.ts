// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { buildMaterialSearchTerms, buildMaterialSummaryTerms } from "../../adapters/xometryConstraints";
import { buildXometryDriverBinding } from "../../adapters/xometryDriver";
import {
  answersFor, choiceAnswer, configurator, createSimulatedSurface, initialConfiguratorState, INJECTION, optionKeys, oraclePolicy,
  recordingDecider, type ConfiguratorState, type SimControl,
} from "../../../test-support/jevDriverSimulator";
import type { QuestionsRequest } from "../questions";
import { runQuoteDriver } from "./loop";
import type { DriverCycleReceipt, DriverLimits, JevDriverCapability } from "./types";

const REQUIRED = { quantity: 25, material: "6061-T6 aluminum" };
const ALLOWED_VALUES = new Set(["25", ...buildMaterialSearchTerms(REQUIRED.material)!, "Black Anodize"]);

function setup(options: {
  state?: Partial<ConfiguratorState>;
  variant?: Parameters<typeof configurator>[0];
  policy?: (request: QuestionsRequest, call: number) => Record<string, unknown>;
  limits?: Partial<DriverLimits>;
  audit?: (receipt: DriverCycleReceipt) => Promise<boolean>;
  churn?: boolean;
  cadUnits?: "mm" | "inch" | null;
  inputTokens?: number;
} = {}) {
  const state = initialConfiguratorState(options.state);
  const sim = createSimulatedSurface(state, configurator(options.variant), { churn: options.churn });
  const decider = recordingDecider(options.policy ?? oraclePolicy, options.inputTokens);
  const receipts: DriverCycleReceipt[] = [];
  const beforeAction = vi.fn(async () => undefined);
  const capability: JevDriverCapability = {
    decide: decider.decide, model: "jev-1.13.0", limits: options.limits,
    audit: options.audit ?? (async (receipt) => { receipts.push(receipt); return true; }),
  };
  const binding = buildXometryDriverBinding({
    quantity: REQUIRED.quantity,
    materialSearchTerms: buildMaterialSearchTerms(REQUIRED.material)!,
    materialSummaryTerms: buildMaterialSummaryTerms(REQUIRED.material)!,
    finishTerms: ["Black Anodize"], includeProcess: false, includeFinish: true, cadUnits: options.cadUnits ?? null,
    beforeAction, blockingSignal: () => null, origin: "https://fixture.invalid",
  });
  const run = () => runQuoteDriver({ surface: sim.surface, binding, capability, now: sim.now });
  return { state, sim, decider, receipts, beforeAction, run };
}

function expectRailsHeld(test: ReturnType<typeof setup>) {
  expect(test.sim.oracle.decoyActivations).toEqual([]);
  expect(test.sim.oracle.typed.every((value) => ALLOWED_VALUES.has(value))).toBe(true);
  for (const request of test.decider.requests) {
    const body = JSON.stringify(request);
    for (const forbidden of ["checkout", "cart", "Place order", "SYSTEM", "jane.doe", "$120", "Request manual quote", "Upload drawing", "5052"]) {
      expect(body).not.toContain(forbidden);
    }
  }
}

describe("Jev quote driver loop on a synthetic configurator", () => {
  it("recovers tonight's failure class (stepper without aria-label) and a wrong default with code shortcuts only", async () => {
    const test = setup();
    const outcome = await test.run();
    expect(outcome).toMatchObject({ status: "completed", verified: ["material", "finish", "quantity"], matched: { material: "6061-T6x", finish: "Black Anodize", quantity: "25" } });
    expect(test.state).toMatchObject({ quantity: "25", material: "Aluminum 6061-T6x (Best Available)", finish: "Black Anodize" });
    expect(test.decider.requests).toHaveLength(0);
    expect(test.sim.oracle.typed).toEqual(["6061-T6", "Black Anodize", "25"]);
    expect(test.sim.oracle.enters).toBe(1);
    expect(test.beforeAction).toHaveBeenCalledTimes(test.sim.oracle.clicks.length + test.sim.oracle.typed.length + 1);
    expect(outcome.status === "completed" && outcome.candidates.filter((candidate) => candidate.field === "quantity").map((candidate) => candidate.kind))
      .toEqual(["label_anchor", "role"]);
    expectRailsHeld(test);
  });

  it("asks Jev only when code cannot decide, with one request per cycle and scrubbed rows", async () => {
    const test = setup({ variant: { materialButton: true } });
    const outcome = await test.run();
    expect(outcome.status).toBe("completed");
    expect(test.decider.requests).toHaveLength(1);
    const [request] = test.decider.requests;
    // Two CLICK candidates: no reversed target head (sent only from three candidates up).
    expect(Object.keys(request.questions).sort()).toEqual(["click_target", "control_present", "op", "op_reversed"]);
    expect(optionKeys(request, "op")).toEqual(["CLICK", "WAIT", "DONE", "BLOCKED"]);
    expect((request.state as { current: unknown }).current).toEqual({ field: "material", status: "pending", attempt: 1 });
    expect(outcome.summary).toMatchObject({ modelCalls: 1, inputTokens: 1_200, costUsdEstimate: 0.0000504, tokensEstimated: false });
    const planned = test.receipts.find((receipt) => receipt.phase === "planned" && receipt.decidedBy === "jev");
    expect(planned).toMatchObject({ op: "CLICK", opConfidence: expect.any(Number), reversedAgrees: true, requestId: "synthetic-1" });
    expect(JSON.stringify(test.receipts)).not.toMatch(/Material|6061|5052|fixture\.invalid/);
    expectRailsHeld(test);
  });

  describe("deny-list", () => {
    it("never offers a deny-listed, linked, offer-card or injected element as a target", async () => {
      const test = setup({ variant: { materialButton: true, materialButtonToggles: true }, limits: { calls: 4 } });
      await test.run();
      const decoyIds = ["checkout", "cart", "manual-quote", "upload-drawing", "offer-card", "material-injection", "save"].map(test.sim.idFor);
      for (const request of test.decider.requests) {
        for (const question of Object.values(request.questions)) {
          if (question.type !== "choice") continue;
          for (const key of Object.keys(question.criteria)) expect(decoyIds).not.toContain(key);
        }
        const rows = (request.state as { elements: Array<{ id: string }> }).elements.map((element) => element.id);
        for (const id of decoyIds.slice(0, 6)) expect(rows).not.toContain(id);
      }
      expectRailsHeld(test);
    });

    it("rejects a decision that names a denied element and acts on nothing", async () => {
      let checkout = "";
      const test = setup({
        variant: { materialButton: true },
        policy: (request) => ({ ...answersFor(request, "CLICK"),
          click_target: { type: "choice", choice: checkout, confidence: 1, probabilities: { [checkout]: 1 } } }),
      });
      checkout = test.sim.idFor("checkout");
      const outcome = await test.run();
      expect(outcome).toMatchObject({ status: "stopped", reason: "invalid_decision", mutationPossible: false });
      expect(test.sim.oracle.clicks).toEqual([]);
      expectRailsHeld(test);
    });

    it("re-runs the deny-list on the live node and stops before executing", async () => {
      const state = initialConfiguratorState();
      const render = configurator({ materialButton: true });
      const sim = createSimulatedSurface(state, (s) => {
        const rendered = render(s);
        return { ...rendered, controls: rendered.controls.map((control): SimControl => control.key === "material-button" ? { ...control, liveDenyText: "Place order" } : control) };
      });
      const decider = recordingDecider(oraclePolicy);
      const outcome = await runQuoteDriver({
        surface: sim.surface, now: sim.now,
        binding: buildXometryDriverBinding({
          quantity: 25, materialSearchTerms: buildMaterialSearchTerms("6061")!, materialSummaryTerms: buildMaterialSummaryTerms("6061")!,
          finishTerms: [], includeProcess: false, includeFinish: false, cadUnits: null, beforeAction: async () => undefined,
          blockingSignal: () => null, origin: "https://fixture.invalid",
        }),
        capability: { decide: decider.decide, model: "jev-1.13.0", audit: async () => true },
      });
      expect(outcome).toMatchObject({ status: "stopped", reason: "deny_hit" });
      expect(sim.oracle.clicks).toEqual([]);
      expect(decider.requests).toHaveLength(1);
    });
  });

  describe("values come from the requirement, never the model", () => {
    it("ignores any value, text or selector a decision carries", async () => {
      const test = setup({
        variant: { materialButton: true },
        policy: (request) => ({ ...oraclePolicy(request), value: "99999", text: INJECTION, selector: "#checkout", fill_value: "7075" }),
      });
      const outcome = await test.run();
      expect(outcome.status).toBe("completed");
      expect(test.state.quantity).toBe("25");
      expectRailsHeld(test);
    });

    it("holds every rail under a seeded random decider", async () => {
      for (let seed = 1; seed <= 25; seed += 1) {
        let value = seed;
        const random = () => { value = (value * 48271) % 2147483647; return value / 2147483647; };
        const test = setup({
          variant: { materialButton: true, materialButtonToggles: seed % 3 === 0 },
          policy: (request) => {
            const pick = (keys: string[]) => keys[Math.floor(random() * keys.length)];
            const answers: Record<string, unknown> = { control_present: { type: "noul", noul: random() } };
            for (const [id, question] of Object.entries(request.questions)) {
              if (question.type !== "choice") continue;
              const keys = Object.keys(question.criteria);
              answers[id] = choiceAnswer(keys, pick(keys), 0.5 + random() / 2);
            }
            return answers;
          },
        });
        const outcome = await test.run();
        expect(outcome.summary.actions).toBeLessThanOrEqual(20);
        expect(outcome.summary.modelCalls).toBeLessThanOrEqual(30);
        expectRailsHeld(test);
      }
    });
  });

  describe("DONE is a proposal that code verifies", () => {
    it("rejects DONE while the page still shows the wrong material and stops at the verification gap", async () => {
      const test = setup({ variant: { materialButton: true }, policy: (request) => answersFor(request, "DONE") });
      const outcome = await test.run();
      expect(outcome).toMatchObject({ status: "stopped", reason: "verification_gap", field: "material" });
      expect(outcome.summary.subGoals.material).toBe("pending");
      expect(test.decider.requests).toHaveLength(2);
      expect(test.sim.oracle.clicks).toEqual([]);
    });
  });

  describe("caps stop runaway loops", () => {
    it("stops on repeated no-op actions", async () => {
      const test = setup({ variant: { materialButton: true, materialButtonInert: true } });
      expect(await test.run()).toMatchObject({ status: "stopped", reason: "no_progress", mutationPossible: true });
      expect(test.sim.oracle.clicks).toHaveLength(3);
    });

    it("stops on repeated WAIT with nothing loading", async () => {
      const test = setup({ variant: { materialButton: true }, policy: (request) => answersFor(request, "WAIT") });
      expect(await test.run()).toMatchObject({ status: "stopped", reason: "no_progress", mutationPossible: false });
      expect(test.decider.requests).toHaveLength(3);
    });

    it("stops at the per-run call cap", async () => {
      const test = setup({ variant: { materialButton: true, materialButtonToggles: true }, limits: { calls: 2 } });
      expect(await test.run()).toMatchObject({ status: "stopped", reason: "budget_calls" });
      expect(test.decider.requests).toHaveLength(2);
    });

    it("stops before a call that would cross the token cap", async () => {
      const test = setup({ variant: { materialButton: true, materialButtonToggles: true }, inputTokens: 55_000 });
      const outcome = await test.run();
      expect(outcome).toMatchObject({ status: "stopped", reason: "budget_tokens" });
      expect(outcome.summary.inputTokens).toBe(110_000);
    });

    it("stops at the per-sub-goal cycle cap", async () => {
      const test = setup({ variant: { materialButton: true, materialButtonToggles: true } });
      expect(await test.run()).toMatchObject({ status: "stopped", reason: "subgoal_budget", field: "material" });
      expect(test.decider.requests).toHaveLength(8);
    });

    it("stops at the action cap", async () => {
      const test = setup({ limits: { actions: 1 } });
      expect(await test.run()).toMatchObject({ status: "stopped", reason: "budget_actions" });
      expect(test.sim.oracle.typed).toEqual(["6061-T6"]);
    });

    it("stops a stale loop without acting when the page never holds still", async () => {
      const test = setup({ variant: { materialButton: true }, churn: true });
      expect(await test.run()).toMatchObject({ status: "stopped", reason: "stale_loop", mutationPossible: false });
      expect(test.sim.oracle.clicks).toEqual([]);
    });
  });

  describe("fail-closed stops", () => {
    it("stops an uncertain action without retrying it", async () => {
      const test = setup({ variant: { materialButton: true } });
      const click = vi.spyOn(test.sim.surface, "click").mockRejectedValue(new Error("synthetic interruption"));
      expect(await test.run()).toMatchObject({ status: "stopped", reason: "action_uncertain", mutationPossible: true });
      expect(click).toHaveBeenCalledTimes(1);
    });

    it("stops before acting when the audit sink cannot record the plan", async () => {
      const test = setup({ audit: async () => false });
      expect(await test.run()).toMatchObject({ status: "stopped", reason: "audit_unavailable", mutationPossible: false });
      expect(test.sim.oracle.typed).toEqual([]);
      expect(test.beforeAction).not.toHaveBeenCalled();
    });

    it("stops when an action changes an unrelated control", async () => {
      const test = setup({ variant: { materialButton: true, materialButtonMutatesNotes: true } });
      expect(await test.run()).toMatchObject({ status: "stopped", reason: "unexpected_mutation", mutationPossible: true });
    });

    it("never breaks a tie between equally accepted options", async () => {
      const test = setup({ variant: { tiedOptions: true } });
      expect(await test.run()).toMatchObject({ status: "stopped", reason: "ambiguous_option", field: "material" });
      expect(test.sim.oracle.clicks).toEqual([]);
    });

    it("stops on an export-control modal before building any request", async () => {
      const test = setup({ variant: { dialog: { text: "Are any parts subject to export control (ITAR)?", keys: ["itar-no"],
        controls: [{ key: "itar-no", role: "radio", tag: "input", name: "No" }] } } });
      expect(await test.run()).toMatchObject({ status: "stopped", reason: "export_control" });
      expect(test.decider.requests).toHaveLength(0);
      expect(test.sim.oracle.clicks).toEqual([]);
    });

    it("stops on a units prompt when code has no units source", async () => {
      const units = [
        { key: "units-mm", role: "radio", tag: "input", name: "Millimeters (mm)", checked: false },
        { key: "units-in", role: "radio", tag: "input", name: "Inches (in)", checked: false },
        { key: "units-continue", role: "button", name: "Continue" },
      ];
      const test = setup({ variant: { dialog: { text: "Confirm model units: mm or inch", keys: units.map((unit) => unit.key), controls: units } } });
      expect(await test.run()).toMatchObject({ status: "stopped", reason: "units_unknown", field: "dialog" });
      expect(test.sim.oracle.clicks).toEqual([]);
    });

    it("selects code-supplied units itself and offers Continue only once the radio reads back checked", async () => {
      const variant: NonNullable<Parameters<typeof configurator>[0]> = {};
      const mm: SimControl = { key: "units-mm", role: "radio", tag: "input", name: "Millimeters (mm)", checked: false, click: () => { mm.checked = true; } };
      const inch: SimControl = { key: "units-in", role: "radio", tag: "input", name: "Inches (in)", checked: false, click: () => { inch.checked = true; } };
      const proceed: SimControl = { key: "units-continue", role: "button", name: "Continue", click: () => { variant.dialog = undefined; } };
      variant.dialog = { text: "Confirm model units: mm or inch", keys: ["units-mm", "units-in", "units-continue"], controls: [mm, inch, proceed] };
      const test = setup({ variant, cadUnits: "mm" });
      expect(await test.run()).toMatchObject({ status: "completed" });
      expect(test.sim.oracle.clicks.slice(0, 2)).toEqual(["units-mm", "units-continue"]);
      expect(inch.checked).toBe(false);
      expect(test.decider.requests).toHaveLength(1);
      expect(optionKeys(test.decider.requests[0], "click_target")).toEqual([test.sim.idFor("units-continue"), "none"]);
    });
  });
});
