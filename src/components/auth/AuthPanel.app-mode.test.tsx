import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { AuthPanel } from "@/components/auth/AuthPanel";

vi.mock("@/hooks/use-app-session", () => ({
  useAppSession: () => ({
    refetch: vi.fn(),
    user: null,
  }),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      getUser: vi.fn(),
      onAuthStateChange: vi.fn(() => ({
        data: {
          subscription: {
            unsubscribe: vi.fn(),
          },
        },
      })),
      signInWithPassword: vi.fn(),
      signUp: vi.fn(),
    },
  },
}));

vi.mock("@/features/quotes/api/session-access", () => ({
  requestPasswordReset: vi.fn(),
  resendSignupConfirmation: vi.fn(),
  updateCurrentUserPassword: vi.fn(),
}));

vi.mock("@/components/SocialAuthButtons", () => ({
  SocialAuthButtons: () => <div>Social login providers</div>,
}));

function renderPanel(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthPanel />
    </MemoryRouter>,
  );
}

describe("AuthPanel app workspace mode", () => {
  it("uses email authentication inside the iOS workspace", () => {
    renderPanel("/quotes/ABC234?app=ios");

    expect(screen.queryByText("Social login providers")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
  });

  it("keeps configured social providers available on the website", () => {
    renderPanel("/quotes/ABC234");

    expect(screen.getByText("Social login providers")).toBeInTheDocument();
  });
});
