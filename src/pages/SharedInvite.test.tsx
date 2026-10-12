import type { ReactNode } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SharedInvite from "./SharedInvite";

const mocks = vi.hoisted(() => ({ acceptProjectInvite: vi.fn() }));

vi.mock("@/features/quotes/api/projects-api", () => ({ acceptProjectInvite: mocks.acceptProjectInvite }));
vi.mock("@/hooks/use-app-session", () => ({
  useAppSession: () => ({ user: { id: "client" }, isVerifiedAuth: true, isAuthInitializing: false }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/workspace/ClientWorkspaceShell", () => ({
  ClientWorkspaceShell: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));
vi.mock("@/components/chat/GuestSidebarCta", () => ({ GuestSidebarCta: () => null }));
vi.mock("@/components/SignInDialog", () => ({ SignInDialog: () => null }));

function renderInvite() {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/invite/token-1"]}>
        <Routes>
          <Route path="/invite/:inviteToken" element={<SharedInvite />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("SharedInvite inline error", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ["stack trace", "TypeError: boom\n    at fn (https://x.invalid/a.js:1:2)"],
    ["SQL detail", 'relation "private_provider_accounts" does not exist'],
    ["internal hostname", "connect ECONNREFUSED worker-api.prod.svc.cluster.local"],
    ["secret", "Invalid API key sb_secret_syntheticLeakSentinel"],
  ])("shows bounded copy for a %s in the inline text", async (_label, leak) => {
    mocks.acceptProjectInvite.mockRejectedValue(new Error(leak));
    renderInvite();

    expect(await screen.findByText("This invite could not be accepted.")).toBeTruthy();
    await waitFor(() => expect(document.body.textContent).not.toContain(leak));
  });

  it("keeps ordinary invite copy", async () => {
    mocks.acceptProjectInvite.mockRejectedValue(new Error("This invite has expired."));
    renderInvite();

    expect(await screen.findByText("This invite has expired.")).toBeTruthy();
  });
});
