// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  annotateProviderMutationFailure,
  createProviderMutationPhase,
  currentProviderMutationPhase,
  markProviderMutationStarted,
  runInProviderMutationPhase,
} from "./providerMutationPhase";
import { VendorAutomationError } from "./types";

describe("providerMutationPhase", () => {
  it("is a no-op outside a tracked task", () => {
    expect(currentProviderMutationPhase()).toBeUndefined();
    expect(() => markProviderMutationStarted()).not.toThrow();
  });

  it("marks the active task phase across awaits and keeps concurrent tasks isolated", async () => {
    const mutating = createProviderMutationPhase();
    const readOnly = createProviderMutationPhase();
    await Promise.all([
      runInProviderMutationPhase(mutating, async () => {
        await Promise.resolve();
        markProviderMutationStarted();
      }),
      runInProviderMutationPhase(readOnly, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }),
    ]);
    expect(mutating.started).toBe(true);
    expect(readOnly.started).toBe(false);
  });

  it("records the phase on vendor error payloads only once mutation started", () => {
    const before = new VendorAutomationError("nav", "navigation_failure", {});
    annotateProviderMutationFailure(before, createProviderMutationPhase());
    expect(before.payload.providerMutationPossible).toBeUndefined();

    const started = createProviderMutationPhase();
    started.started = true;
    const after = new VendorAutomationError("nav", "navigation_failure", {});
    annotateProviderMutationFailure(after, started);
    expect(after.payload.providerMutationPossible).toBe(true);
    expect(() => annotateProviderMutationFailure(new Error("plain"), started)).not.toThrow();
    expect(() => annotateProviderMutationFailure("thrown string", started)).not.toThrow();
  });
});
