// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  createProviderMutationPhase,
  currentProviderMutationPhase,
  markProviderMutationStarted,
  providerMutationEvidence,
  runInProviderMutationPhase,
} from "./providerMutationPhase";

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

  it("adds persisted failure evidence only once mutation started", async () => {
    expect(providerMutationEvidence()).toEqual({});
    expect(providerMutationEvidence(createProviderMutationPhase())).toEqual({});

    const started = createProviderMutationPhase();
    started.started = true;
    expect(providerMutationEvidence(started)).toEqual({ providerMutationPossible: true });

    const tracked = createProviderMutationPhase();
    const insideTask = await runInProviderMutationPhase(tracked, async () => {
      const before = providerMutationEvidence();
      markProviderMutationStarted();
      return { before, after: providerMutationEvidence() };
    });
    expect(insideTask).toEqual({ before: {}, after: { providerMutationPossible: true } });
  });
});
