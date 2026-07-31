import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MfaStepUpDialog } from "./MfaStepUpDialog";

const mfaApiMock = vi.hoisted(() => ({
  beginTotpEnrollment: vi.fn(),
  listTotpFactors: vi.fn(),
  unenrollTotpFactor: vi.fn(),
  verifyTotpCode: vi.fn(),
}));

vi.mock("@/features/auth/mfa-api", () => ({
  beginTotpEnrollment: mfaApiMock.beginTotpEnrollment,
  listTotpFactors: mfaApiMock.listTotpFactors,
  unenrollTotpFactor: mfaApiMock.unenrollTotpFactor,
  verifyTotpCode: mfaApiMock.verifyTotpCode,
}));

function renderDialog({
  open = true,
  onOpenChange = vi.fn(),
  onVerified = vi.fn(),
}: {
  open?: boolean;
  onOpenChange?: ReturnType<typeof vi.fn>;
  onVerified?: ReturnType<typeof vi.fn>;
} = {}) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  render(
    <QueryClientProvider client={queryClient}>
      <MfaStepUpDialog
        open={open}
        onOpenChange={onOpenChange}
        onVerified={onVerified}
      />
    </QueryClientProvider>,
  );

  return { onOpenChange, onVerified };
}

describe("MfaStepUpDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mfaApiMock.listTotpFactors.mockResolvedValue([]);
    mfaApiMock.beginTotpEnrollment.mockResolvedValue({
      factorId: "factor-new",
      qrCode: "data:image/svg+xml;base64,qr-code",
      secret: "TOTP-SECRET-123",
      uri: "otpauth://totp/OverDrafter",
    });
    mfaApiMock.unenrollTotpFactor.mockResolvedValue(undefined);
    mfaApiMock.verifyTotpCode.mockResolvedValue(undefined);
  });

  it("shows a focused loading state while authenticator factors load", () => {
    mfaApiMock.listTotpFactors.mockReturnValue(new Promise(() => undefined));

    renderDialog();

    expect(
      screen.getByLabelText("Loading authenticator factors"),
    ).toBeInTheDocument();
  });

  it("remains idle while closed without repeatedly resetting mutation state", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    renderDialog({ open: false });
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(mfaApiMock.listTotpFactors).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalledWith(
      expect.stringContaining("Maximum update depth exceeded"),
    );
    consoleError.mockRestore();
  });

  it("shows a factor-loading error", async () => {
    mfaApiMock.listTotpFactors
      .mockRejectedValueOnce(new Error("Authenticator factors unavailable"))
      .mockResolvedValue([]);

    renderDialog();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Authenticator factors unavailable",
    );
    expect(
      screen.queryByRole("button", { name: "Set up authenticator" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(
      await screen.findByRole("button", { name: "Set up authenticator" }),
    ).toBeInTheDocument();
  });

  it("verifies the selected verified factor then refreshes access and closes", async () => {
    mfaApiMock.listTotpFactors.mockResolvedValue([
      {
        id: "factor-verified",
        friendlyName: "Blaine's authenticator",
        status: "verified",
        createdAt: "2026-07-01T12:00:00.000Z",
      },
      {
        id: "factor-unverified",
        friendlyName: "Old authenticator",
        status: "unverified",
        createdAt: "2026-06-01T12:00:00.000Z",
      },
    ]);
    const onVerified = vi.fn().mockResolvedValue(undefined);
    const onOpenChange = vi.fn();
    renderDialog({ onVerified, onOpenChange });

    expect(await screen.findByText("Blaine's authenticator")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Authenticator code"), {
      target: { value: "123456" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));

    await waitFor(() => {
      expect(mfaApiMock.verifyTotpCode).toHaveBeenCalledWith({
        factorId: "factor-verified",
        code: "123456",
      });
    });
    expect(onVerified).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("enrolls a new factor and displays its QR code and secret", async () => {
    renderDialog();

    fireEvent.click(
      await screen.findByRole("button", { name: "Set up authenticator" }),
    );

    const qrCode = await screen.findByRole("img", {
      name: "Authenticator enrollment QR code",
    });
    expect(qrCode).toHaveAttribute(
      "src",
      "data:image/svg+xml;base64,qr-code",
    );
    expect(screen.getByText("TOTP-SECRET-123")).toBeInTheDocument();
    expect(screen.getByLabelText("Authenticator code")).toBeInTheDocument();
  });

  it("shows an invalid-code error for a newly enrolled factor", async () => {
    mfaApiMock.verifyTotpCode.mockRejectedValue(
      new Error("The authenticator code is invalid."),
    );
    renderDialog();

    fireEvent.click(
      await screen.findByRole("button", { name: "Set up authenticator" }),
    );
    await screen.findByRole("img", {
      name: "Authenticator enrollment QR code",
    });
    fireEvent.change(screen.getByLabelText("Authenticator code"), {
      target: { value: "654321" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The authenticator code is invalid.",
    );
    expect(mfaApiMock.verifyTotpCode).toHaveBeenCalledWith({
      factorId: "factor-new",
      code: "654321",
    });
  });

  it("removes an abandoned enrollment before closing", async () => {
    const onOpenChange = vi.fn();
    renderDialog({ onOpenChange });

    fireEvent.click(
      await screen.findByRole("button", { name: "Set up authenticator" }),
    );
    await screen.findByRole("img", {
      name: "Authenticator enrollment QR code",
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => {
      expect(mfaApiMock.unenrollTotpFactor).toHaveBeenCalledWith("factor-new");
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("keeps enrollment recovery visible when abandoned-factor cleanup fails", async () => {
    mfaApiMock.unenrollTotpFactor.mockRejectedValue(
      new Error("Authenticator cleanup failed"),
    );
    const onOpenChange = vi.fn();
    renderDialog({ onOpenChange });

    fireEvent.click(
      await screen.findByRole("button", { name: "Set up authenticator" }),
    );
    await screen.findByRole("img", {
      name: "Authenticator enrollment QR code",
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Authenticator cleanup failed",
    );
    expect(
      screen.getByText("TOTP-SECRET-123"),
    ).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});
