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

vi.mock("@/components/debug/DiagnosticsBootstrap", () => ({
  DiagnosticsBootstrap: () => null,
}));

vi.mock("@/components/debug/ExtractionLauncher", () => ({
  ExtractionLauncher: () => null,
}));

vi.mock("@/components/debug/FixturePanel", () => ({
  FixturePanel: () => null,
}));

vi.mock("@/components/debug/AppErrorBoundary", () => ({
  AppErrorBoundary: ({ children }: PropsWithChildren) => <>{children}</>,
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

vi.mock("./pages/ClientProject", () => ({
  default: () => <div>Client Project Page</div>,
}));

vi.mock("./pages/ClientPart", () => ({
  default: () => <div>Client Part Page</div>,
}));

vi.mock("./pages/ClientProjectReview", () => ({
  default: () => <div>Client Project Review Page</div>,
}));

vi.mock("./pages/ClientPartReview", () => ({
  default: () => <div>Client Part Review Page</div>,
}));

vi.mock("./pages/SharedInvite", () => ({
  default: () => <div>Shared Invite Page</div>,
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      getSession: vi.fn(() => Promise.resolve({ data: { session: null }, error: null })),
      getUser: vi.fn(),
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
    },
  },
}));

import App from "./App";
import { shouldCaptureMutationDiagnostic } from "@/lib/react-query-diagnostics";

describe("App routes", () => {
  beforeEach(() => {
    const storage = new Map<string, string>();
    const localStorageMock = {
      getItem: vi.fn((key: string) => storage.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => {
        storage.set(key, value);
      }),
      removeItem: vi.fn((key: string) => {
        storage.delete(key);
      }),
      clear: vi.fn(() => {
        storage.clear();
      }),
    };

    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("localStorage", localStorageMock);
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      writable: true,
      value: localStorageMock,
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
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

  it("renders the shared client project route", () => {
    window.history.pushState({}, "", "/projects/project-42");

    render(<App />);

    expect(screen.getByText("Client Project Page")).toBeInTheDocument();
  });

  it("renders the part detail route", () => {
    window.history.pushState({}, "", "/parts/job-42");

    render(<App />);

    expect(screen.getByText("Client Part Page")).toBeInTheDocument();
  });

  it("renders the part review route", () => {
    window.history.pushState({}, "", "/parts/job-42/review");

    render(<App />);

    expect(screen.getByText("Client Part Review Page")).toBeInTheDocument();
  });

  it("renders the project review route", () => {
    window.history.pushState({}, "", "/projects/project-42/review");

    render(<App />);

    expect(screen.getByText("Client Project Review Page")).toBeInTheDocument();
  });

  it("renders the shared invite route", () => {
    window.history.pushState({}, "", "/shared/invite-token");

    render(<App />);

    expect(screen.getByText("Shared Invite Page")).toBeInTheDocument();
  });

  it("falls back to the not found route for unknown paths", () => {
    window.history.pushState({}, "", "/not-a-route");

    render(<App />);

    expect(screen.getByText("Not Found Page")).toBeInTheDocument();
  });

  it("suppresses known benign mutation diagnostics when the mutation meta opts out", () => {
    expect(
      shouldCaptureMutationDiagnostic({
        error: new Error("Your account already has an organization membership."),
        meta: {
          suppressDiagnosticErrorMessages: ["already has an organization membership"],
        },
      }),
    ).toBe(false);
  });

  it("still captures mutation diagnostics when the error does not match the suppression list", () => {
    expect(
      shouldCaptureMutationDiagnostic({
        error: new Error("Permission denied"),
        meta: {
          suppressDiagnosticErrorMessages: ["already has an organization membership"],
        },
      }),
    ).toBe(true);
  });
});
