import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/ui/toaster", () => ({
  Toaster: () => null,
}));

vi.mock("@/components/ui/sonner", () => ({
  Toaster: () => null,
}));

vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: PropsWithChildren) => <>{children}</>,
}));

vi.mock("./pages/Index", () => ({
  default: () => <div>Index Page</div>,
}));

vi.mock("./pages/SignIn", () => ({
  default: () => <div>Sign In Page</div>,
}));

vi.mock("./pages/NotFound", () => ({
  default: () => <div>Not Found Page</div>,
}));

vi.mock("./pages/JobCreate", () => ({
  default: () => <div>Job Create Page</div>,
}));

vi.mock("./pages/InternalJobDetail", () => ({
  default: () => <div>Internal Job Detail Page</div>,
}));

vi.mock("./pages/ClientPackage", () => ({
  default: () => <div>Client Package Page</div>,
}));

import App from "./App";

describe("App routes", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    window.history.replaceState({}, "", "/");
  });

  it("renders the job creation route", () => {
    window.history.pushState({}, "", "/jobs/new");

    render(<App />);

    expect(screen.getByText("Job Create Page")).toBeInTheDocument();
  });

  it("renders the dynamic client package route", () => {
    window.history.pushState({}, "", "/client/packages/pkg-42");

    render(<App />);

    expect(screen.getByText("Client Package Page")).toBeInTheDocument();
  });

  it("falls back to the not found route for unknown paths", () => {
    window.history.pushState({}, "", "/not-a-route");

    render(<App />);

    expect(screen.getByText("Not Found Page")).toBeInTheDocument();
  });
});
