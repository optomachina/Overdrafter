import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SignIn from "@/pages/SignIn";
import { AuthPanel } from "./AuthPanel";

const mocks = vi.hoisted(() => ({
  signInWithPassword: vi.fn(),
  signUp: vi.fn(),
  updateCurrentUserPassword: vi.fn(),
  refetch: vi.fn(),
  onSuccess: vi.fn(),
  toastSuccess: vi.fn(),
  toastWarning: vi.fn(),
  toastError: vi.fn(),
  user: null as { id: string } | null,
}));

vi.mock("@/hooks/use-app-session", () => ({
  useAppSession: () => ({ user: mocks.user, refetch: mocks.refetch }),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      onAuthStateChange: vi.fn(() => ({
        data: { subscription: { unsubscribe: vi.fn() } },
      })),
      signInWithPassword: mocks.signInWithPassword,
      signUp: mocks.signUp,
    },
  },
}));

vi.mock("@/features/quotes/api/session-access", () => ({
  requestPasswordReset: vi.fn(),
  resendSignupConfirmation: vi.fn(),
  updateCurrentUserPassword: mocks.updateCurrentUserPassword,
}));

vi.mock("@/components/SocialAuthButtons", () => ({
  SocialAuthButtons: () => null,
}));

vi.mock("sonner", () => ({
  toast: {
    success: mocks.toastSuccess,
    warning: mocks.toastWarning,
    error: mocks.toastError,
  },
}));

function PasswordChangePanel() {
  const location = useLocation();

  return (
    <>
      <SignIn />
      <p data-testid="password-change-query">{location.search}</p>
    </>
  );
}

function renderPanel(path = "/", initialMode: "sign-in" | "update-password" = "sign-in") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/" element={<AuthPanel initialMode={initialMode} onSuccess={mocks.onSuccess} />} />
        <Route path="/signin" element={<PasswordChangePanel />} />
      </Routes>
    </MemoryRouter>,
  );
}

function submitPasswordSignIn() {
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "person@example.com" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "old-password" } });
  fireEvent.click(screen.getAllByRole("button", { name: "Log in" })[1]);
}

function weakPasswordError() {
  return Object.assign(new Error("provider detail should not be shown"), {
    code: "weak_password",
  });
}

describe("AuthPanel password strength handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.user = null;
    mocks.refetch.mockResolvedValue(undefined);
  });

  it.each(["/", "/?app=ios"])(
    "keeps a successful %s sign-in and offers password change when Supabase reports weakness",
    async (path) => {
      mocks.signInWithPassword.mockResolvedValue({
        data: {
          user: { id: "user-1" },
          session: { access_token: "valid-token" },
          weakPassword: { reasons: ["pwned"], message: "provider detail should not be shown" },
        },
        error: null,
      });
      renderPanel(path);

      submitPasswordSignIn();

      await waitFor(() => expect(mocks.onSuccess).toHaveBeenCalledTimes(1));
      expect(mocks.toastWarning).toHaveBeenCalledWith(
        expect.stringMatching(/signed in/i),
        expect.objectContaining({
          description: expect.stringMatching(/password/i),
          duration: Number.POSITIVE_INFINITY,
          closeButton: true,
          action: expect.objectContaining({
            label: "Change password",
            onClick: expect.any(Function),
          }),
        }),
      );
      expect(mocks.toastSuccess).not.toHaveBeenCalled();
      expect(mocks.toastError).not.toHaveBeenCalled();
      expect(JSON.stringify(mocks.toastWarning.mock.calls)).not.toContain("provider detail");

      mocks.user = { id: "user-1" };
      const warningOptions = mocks.toastWarning.mock.calls[0][1];
      warningOptions.action.onClick();
      expect((await screen.findAllByText("Choose a new password")).length).toBeGreaterThan(0);
      expect(screen.getAllByRole("button", { name: "Update password" })[0]).toBeEnabled();
      expect(screen.queryByText("Sign in to OverDrafter with Google")).not.toBeInTheDocument();
      expect(screen.getByTestId("password-change-query")).toHaveTextContent(
        path.includes("app=ios") ? "?mode=recovery&app=ios" : "?mode=recovery",
      );
    },
  );

  it("keeps ordinary sign-in unchanged", async () => {
    mocks.signInWithPassword.mockResolvedValue({
      data: { user: { id: "user-1" }, session: { access_token: "valid-token" } },
      error: null,
    });
    renderPanel();

    submitPasswordSignIn();

    await waitFor(() => expect(mocks.onSuccess).toHaveBeenCalledTimes(1));
    expect(mocks.toastSuccess).toHaveBeenCalledWith("Signed in successfully.");
    expect(mocks.toastWarning).not.toHaveBeenCalled();
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("explains a rejected new password without exposing provider details", async () => {
    mocks.signUp.mockResolvedValue({ data: { session: null }, error: weakPasswordError() });
    renderPanel();
    fireEvent.click(screen.getAllByRole("button", { name: "Sign up" })[0]);
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "person@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "old-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledTimes(1));
    expect(mocks.toastError).toHaveBeenCalledWith(expect.stringMatching(/stronger password/i));
    expect(JSON.stringify(mocks.toastError.mock.calls)).not.toContain("provider detail");
    expect(mocks.onSuccess).not.toHaveBeenCalled();
  });

  it("explains a rejected password update and does not claim success", async () => {
    mocks.user = { id: "user-1" };
    mocks.updateCurrentUserPassword.mockRejectedValue(weakPasswordError());
    renderPanel("/", "update-password");
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "old-password" } });
    fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: "old-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Update password" }));

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledTimes(1));
    expect(mocks.toastError).toHaveBeenCalledWith(expect.stringMatching(/stronger password/i));
    expect(JSON.stringify(mocks.toastError.mock.calls)).not.toContain("provider detail");
    expect(mocks.onSuccess).not.toHaveBeenCalled();
    expect(mocks.refetch).not.toHaveBeenCalled();
  });
});
