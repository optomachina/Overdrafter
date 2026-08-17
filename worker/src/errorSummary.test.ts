import { describe, expect, it } from "vitest";
import {
  buildWorkerTaskFailureEvidence,
  MAX_WORKER_ERROR_MESSAGE_LENGTH,
  summarizeWorkerError,
  UNKNOWN_WORKER_ERROR_MESSAGE,
} from "./errorSummary.js";

describe("summarizeWorkerError", () => {
  it("preserves a normal Error message", () => {
    expect(summarizeWorkerError(new Error("worker failed"))).toBe("worker failed");
  });

  it("extracts the message from a Supabase-style plain object", () => {
    expect(
      summarizeWorkerError({
        code: "P0001",
        details: "private diagnostic",
        message: "Quote lane registration was denied.",
      }),
    ).toBe("Quote lane registration was denied.");
  });

  it("does not serialize unrelated object fields", () => {
    expect(
      summarizeWorkerError({
        code: "secret-code",
        details: "storage-state-secret",
      }),
    ).toBe(UNKNOWN_WORKER_ERROR_MESSAGE);
  });

  it.each([
    ["blank object message", { message: "   " }],
    ["non-string object message", { message: { secret: "do-not-serialize" } }],
    ["array", [{ message: "do-not-use" }]],
    ["symbol", Symbol("do-not-coerce")],
    ["number", 42],
    ["null", null],
  ])("uses the neutral fallback for %s", (_label, value) => {
    expect(summarizeWorkerError(value)).toBe(UNKNOWN_WORKER_ERROR_MESSAGE);
  });

  it("uses the neutral fallback when reading message throws", () => {
    const thrownValue = Object.create(null, {
      message: {
        get() {
          throw new Error("getter secret");
        },
      },
    });

    expect(summarizeWorkerError(thrownValue)).toBe(UNKNOWN_WORKER_ERROR_MESSAGE);
  });

  it("keeps failure evidence safe when Error accessors throw", () => {
    class MalformedError extends Error {
      override get message(): string {
        throw new Error("message getter secret");
      }

      override get name(): string {
        throw new Error("name getter secret");
      }
    }

    expect(buildWorkerTaskFailureEvidence(new MalformedError(), "task_failure", 0)).toEqual({
      failureMessage: UNKNOWN_WORKER_ERROR_MESSAGE,
      runtimeError: {
        name: "Error",
        message: UNKNOWN_WORKER_ERROR_MESSAGE,
      },
      payload: {
        failureMessage: UNKNOWN_WORKER_ERROR_MESSAGE,
        failureCode: "task_failure",
        retryCount: 0,
      },
    });
  });

  it("bounds persisted messages", () => {
    const oversizedMessage = "x".repeat(MAX_WORKER_ERROR_MESSAGE_LENGTH + 50);

    expect(summarizeWorkerError({ message: oversizedMessage })).toBe(
      "x".repeat(MAX_WORKER_ERROR_MESSAGE_LENGTH),
    );
  });

  it("preserves a directly thrown string", () => {
    expect(summarizeWorkerError("direct failure")).toBe("direct failure");
  });

  it("uses the same safe summary for last_error and the task payload", () => {
    const evidence = buildWorkerTaskFailureEvidence(
      { message: "Provider preflight was denied.", details: "do-not-persist" },
      "task_failure",
      2,
    );

    expect(evidence).toEqual({
      failureMessage: "Provider preflight was denied.",
      runtimeError: {
        name: "Error",
        message: "Provider preflight was denied.",
      },
      payload: {
        failureMessage: "Provider preflight was denied.",
        failureCode: "task_failure",
        retryCount: 2,
      },
    });
    expect(JSON.stringify(evidence)).not.toContain("do-not-persist");
  });
});
