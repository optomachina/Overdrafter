import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/ui/sonner", () => ({
  Toaster: () => null,
}));

vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: PropsWithChildren) => <>{children}</>,
}));

vi.mock("agentation", () => ({
  Agentation: () => <div data-testid="annotation-toolbar" />,
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

vi.mock("./pages/CommercialAccounts", () => ({
  default: () => <div>Commercial Accounts Page</div>,
}));

vi.mock("./pages/CommercialAccountDetail", () => ({
  default: () => <div>Commercial Account Detail Page</div>,
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

vi.mock("./pages/ClientParts", () => ({
  default: () => <div>Client Parts Page</div>,
}));

vi.mock("./pages/ClientQuotes", () => ({
  default: () => <div>Client Quotes Page</div>,
}));

vi.mock("./pages/ClientQuoteDetail", () => ({
  default: () => <div>Client Quote Detail Page</div>,
}));

vi.mock("./pages/ClientSearch", () => ({
  default: () => <div>Client Search Page</div>,
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
    vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })));
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
    vi.unstubAllEnvs();
    window.history.replaceState({}, "", "/");
  });

  it("mounts annotations in the ordinary development presentation", async () => {
    vi.stubEnv("DEV", true);
    render(<App />);
    expect(await screen.findByTestId("annotation-toolbar")).toBeInTheDocument();
  });

  it.each(["/?embed=1", "/?app=ios"])("omits annotations for %s", (path) => {
    vi.stubEnv("DEV", true);
    window.history.pushState({}, "", path);
    render(<App />);
    expect(screen.queryByTestId("annotation-toolbar")).not.toBeInTheDocument();
  });

  it("omits annotations outside development", () => {
    vi.stubEnv("DEV", false);
    render(<App />);
    expect(screen.queryByTestId("annotation-toolbar")).not.toBeInTheDocument();
  });

  it("renders the job creation route", async () => {
    window.history.pushState({}, "", "/jobs/new");

    render(<App />);

    expect(await screen.findByText("Job Create Page")).toBeInTheDocument();
  });

  it("renders the dynamic client package route", async () => {
    window.history.pushState({}, "", "/client/packages/pkg-42");

    render(<App />);

    expect(await screen.findByText("Client Package Page")).toBeInTheDocument();
  });

  it("renders the commercial accounts route", async () => {
    window.history.pushState({}, "", "/internal/commercial");

    render(<App />);

    expect(await screen.findByText("Commercial Accounts Page")).toBeInTheDocument();
  });

  it("renders the commercial account detail route", async () => {
    window.history.pushState({}, "", "/internal/commercial/org-42");

    render(<App />);

    expect(await screen.findByText("Commercial Account Detail Page")).toBeInTheDocument();
  });

  it("renders the shared client project route", async () => {
    window.history.pushState({}, "", "/projects/project-42");

    render(<App />);

    expect(await screen.findByText("Client Project Page")).toBeInTheDocument();
  });

  it("renders the part detail route", async () => {
    window.history.pushState({}, "", "/parts/job-42");

    render(<App />);

    expect(await screen.findByText("Client Part Page")).toBeInTheDocument();
  });

  it("renders the parts collection route", async () => {
    window.history.pushState({}, "", "/parts");

    render(<App />);

    expect(await screen.findByText("Client Parts Page")).toBeInTheDocument();
  });

  it("renders the quotes collection route", async () => {
    window.history.pushState({}, "", "/quotes");

    render(<App />);

    expect(await screen.findByText("Client Quotes Page")).toBeInTheDocument();
  });

  it("renders the quote detail route", async () => {
    window.history.pushState({}, "", "/quotes/Q7K9MF");

    render(<App />);

    expect(await screen.findByText("Client Quote Detail Page")).toBeInTheDocument();
  });

  it("renders the global search route", async () => {
    window.history.pushState({}, "", "/search");

    render(<App />);

    expect(await screen.findByText("Client Search Page")).toBeInTheDocument();
  });

  it("renders the part review route", async () => {
    window.history.pushState({}, "", "/parts/job-42/review");

    render(<App />);

    expect(await screen.findByText("Client Part Review Page")).toBeInTheDocument();
  });

  it("renders the project review route", async () => {
    window.history.pushState({}, "", "/projects/project-42/review");

    render(<App />);

    expect(await screen.findByText("Client Project Review Page")).toBeInTheDocument();
  });

  it("renders the shared invite route", async () => {
    window.history.pushState({}, "", "/shared/invite-token");

    render(<App />);

    expect(await screen.findByText("Shared Invite Page")).toBeInTheDocument();
  });

  it("renders the public Founding Beta terms route", async () => {
    window.history.pushState({}, "", "/legal/beta-terms");

    render(<App />);

    expect(await screen.findByRole("heading", { name: "Founding Beta Terms" })).toBeInTheDocument();
    expect(await screen.findByText("founding-beta-2026-08-15")).toBeInTheDocument();
  });

  it("renders the public privacy route", async () => {
    window.history.pushState({}, "", "/legal/privacy");

    render(<App />);

    expect(await screen.findByRole("heading", { name: "Privacy & data handling" })).toBeInTheDocument();
  });

  it("falls back to the not found route for unknown paths", async () => {
    window.history.pushState({}, "", "/not-a-route");

    render(<App />);

    expect(await screen.findByText("Not Found Page")).toBeInTheDocument();
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
