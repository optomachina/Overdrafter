import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDiagnosticsSnapshot, resetDiagnosticsForTests } from "@/lib/diagnostics";
import { AppErrorBoundary } from "./AppErrorBoundary";

// Synthetic, unsigned JWT shape ({"alg":"none"} . {"role":"synthetic"} . "synthetic") plus a
// service-role marker, as a server-provided render failure might carry.
const RAW_MESSAGE = `${["eyJhbGciOiJub25lIn0", "eyJyb2xlIjoic3ludGhldGljIn0", "c3ludGhldGlj"].join(".")} service_role`;

function ThrowingChild(): never {
  throw new Error(RAW_MESSAGE);
}

function renderFailure() {
  return render(
    <AppErrorBoundary>
      <ThrowingChild />
    </AppErrorBoundary>,
  );
}

function expectRecoveryChrome() {
  expect(screen.getByRole("heading", { name: "The app hit a render failure." })).toBeInTheDocument();
  const event = getDiagnosticsSnapshot().events.find((entry) => entry.source === "react.error-boundary");
  expect(event?.error?.message).toBe(RAW_MESSAGE);
  expect(screen.getByText(`Reference: ${event?.id}`)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Reload app" })).toBeEnabled();
}

describe("AppErrorBoundary", () => {
  beforeEach(() => {
    resetDiagnosticsForTests();
    // React reports the caught render error to the console; keep the test output readable.
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllEnvs();
    resetDiagnosticsForTests();
  });

  it("shows only the generic message outside development while diagnostics keep the raw error", () => {
    vi.stubEnv("DEV", false);
    const { container } = renderFailure();

    expectRecoveryChrome();
    expect(screen.getByText("Something went wrong.")).toBeInTheDocument();
    expect(container.innerHTML).not.toContain(RAW_MESSAGE);
    expect(container.textContent).not.toContain("service_role");
  });

  it("shows the raw message in development", () => {
    vi.stubEnv("DEV", true);
    renderFailure();

    expectRecoveryChrome();
    expect(screen.getByText(RAW_MESSAGE)).toBeInTheDocument();
    expect(screen.queryByText("Something went wrong.")).not.toBeInTheDocument();
  });
});
