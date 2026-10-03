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

  it.each([
    ["job creation route", "/jobs/new", "Job Create Page"],
    ["dynamic client package route", "/client/packages/pkg-42", "Client Package Page"],
    ["commercial accounts route", "/internal/commercial", "Commercial Accounts Page"],
    ["commercial account detail route", "/internal/commercial/org-42", "Commercial Account Detail Page"],
    ["shared client project route", "/projects/project-42", "Client Project Page"],
    ["part detail route", "/parts/job-42", "Client Part Page"],
    ["parts collection route", "/parts", "Client Parts Page"],
    ["quotes collection route", "/quotes", "Client Quotes Page"],
    ["quote detail route", "/quotes/Q7K9MF", "Client Quote Detail Page"],
    ["global search route", "/search", "Client Search Page"],
    ["part review route", "/parts/job-42/review", "Client Part Review Page"],
    ["project review route", "/projects/project-42/review", "Client Project Review Page"],
    ["shared invite route", "/shared/invite-token", "Shared Invite Page"],
  ])("renders the %s", async (_name, path, pageText) => {
    window.history.pushState({}, "", path);

    render(<App />);

    expect(await screen.findByText(pageText)).toBeInTheDocument();
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
