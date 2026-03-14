import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  captureDiagnosticError,
  createDiagnosticClipboardText,
  getDiagnosticsSnapshot,
  installDiagnostics,
  recordDiagnosticEvent,
  resetDiagnosticsForTests,
  updateDiagnosticsContext,
} from "./diagnostics";

describe("diagnostics", () => {
  beforeEach(() => {
    resetDiagnosticsForTests();
  });

  afterEach(() => {
    resetDiagnosticsForTests();
  });

  it("captures structured errors with the current app context", () => {
    updateDiagnosticsContext({
      route: "/projects/project-42",
      userEmail: "client@example.com",
      membershipRole: "client",
      sessionState: "signed_in",
    });

    const eventId = captureDiagnosticError(
      {
        name: "PostgrestError",
        message: "permission denied",
        code: "42501",
        hint: "Check RLS policies",
      },
      {
        category: "manual",
        source: "test.capture",
        handled: true,
      },
    );

    const snapshot = getDiagnosticsSnapshot();
    expect(eventId).toBeTruthy();
    expect(snapshot.counts.error).toBe(1);
    expect(snapshot.events[0]).toMatchObject({
      id: eventId,
      message: "permission denied",
      source: "test.capture",
      context: {
        route: "/projects/project-42",
        userEmail: "client@example.com",
      },
      error: {
        code: "42501",
        hint: "Check RLS policies",
      },
    });
  });

  it("tracks info and warning counts for manual diagnostic events", () => {
    recordDiagnosticEvent({
      level: "info",
      category: "manual",
      source: "test.info",
      message: "first event",
      handled: true,
    });

    recordDiagnosticEvent({
      level: "warn",
      category: "manual",
      source: "test.warn",
      message: "second event",
      handled: true,
      details: {
        foo: "bar",
      },
    });

    const snapshot = getDiagnosticsSnapshot();
    expect(snapshot.counts.info).toBe(1);
    expect(snapshot.counts.warn).toBe(1);
    expect(snapshot.events).toHaveLength(2);
    expect(snapshot.events[0]?.details).toEqual({ foo: "bar" });
  });

  it("installs global listeners and captures uncaught window errors", () => {
    installDiagnostics();

    window.dispatchEvent(
      new ErrorEvent("error", {
        message: "Window exploded",
      }),
    );

    expect(window.__OVERDRAFTER_DEBUG__).toBeDefined();
    expect(getDiagnosticsSnapshot().events[0]).toMatchObject({
      category: "window-error",
      message: "Window exploded",
    });
  });

  it("ignores the known stale Supabase refresh-token console error", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    installDiagnostics();

    console.error({
      name: "AuthApiError",
      message: "Invalid Refresh Token: Refresh Token Not Found",
    });

    expect(getDiagnosticsSnapshot().events).toHaveLength(1);
    expect(getDiagnosticsSnapshot().events[0]).toMatchObject({
      source: "diagnostics.install",
      message: "Diagnostics listeners installed.",
    });
  });

  it("builds a focused clipboard payload with context and recent event details", () => {
    updateDiagnosticsContext({
      route: "/internal/jobs/job-42",
      href: "https://app.example.com/internal/jobs/job-42",
      userEmail: "estimator@example.com",
      membershipRole: "internal_estimator",
      organizationId: "org-42",
      sessionState: "signed_in",
    });

    const eventId = captureDiagnosticError(new Error("Quote package publish failed"), {
      category: "react-mutation",
      source: "react-query.mutation",
      handled: true,
      details: {
        jobId: "job-42",
      },
    });

    const clipboardText = createDiagnosticClipboardText({
      title: "Overdrafter latest error",
      event: getDiagnosticsSnapshot().events[0] ?? null,
    });

    expect(clipboardText).toContain("Help debug this Overdrafter issue in Codex.");
    expect(clipboardText).toContain("Overdrafter latest error");
    expect(clipboardText).toContain("Issue: Quote package publish failed");
    expect(clipboardText).toContain("- Route: /internal/jobs/job-42");
    expect(clipboardText).toContain("estimator@example.com");
    expect(clipboardText).toContain(eventId);
    expect(clipboardText).toContain("Quote package publish failed");
    expect(clipboardText).toContain("\"jobId\": \"job-42\"");
  });

  it("starts each fresh boot with a new session and no retained events while preserving launcher state", async () => {
    const firstModule = await import("./diagnostics");

    firstModule.setDiagnosticsEnabled(true);
    firstModule.recordDiagnosticEvent({
      level: "error",
      category: "manual",
      source: "test.bootstrap",
      message: "stale event",
      handled: true,
    });

    const firstSnapshot = firstModule.getDiagnosticsSnapshot();
    expect(firstSnapshot.enabled).toBe(true);
    expect(firstSnapshot.events).toHaveLength(1);

    vi.resetModules();

    const secondModule = await import("./diagnostics");
    const secondSnapshot = secondModule.getDiagnosticsSnapshot();

    expect(secondSnapshot.enabled).toBe(true);
    expect(secondSnapshot.events).toHaveLength(0);
    expect(secondSnapshot.sessionId).not.toBe(firstSnapshot.sessionId);

    secondModule.resetDiagnosticsForTests();
  });
});
