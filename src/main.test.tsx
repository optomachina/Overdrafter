import "@testing-library/jest-dom/vitest";
import { act, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";

const failure = vi.hoisted(() => ({ error: new Error() }));
vi.mock("./App", () => { throw failure.error; });

// Track the real root so each entrypoint import is unmounted after its assertion.
let root: Root | undefined;
vi.mock("react-dom/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-dom/client")>();
  return {
    ...actual,
    createRoot: (...args: Parameters<typeof createRoot>) => {
      root = actual.createRoot(...args);
      return root;
    },
  };
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("root boot failure recovery", () => {
  it.each([
    new Error("VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY are required."),
    new TypeError("Failed to fetch dynamically imported module"),
  ])("shows recovery controls for $message", async (error) => {
    vi.resetModules();
    failure.error = error;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    document.body.innerHTML = '<div id="root"></div>';

    await act(async () => { await import("./main"); });

    expect(await screen.findByRole("heading", { name: "The app hit a render failure." })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reload app" })).toBeInTheDocument();
  });
});
