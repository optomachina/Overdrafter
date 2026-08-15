import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PromptComposer } from "./PromptComposer";

const mockToastError = vi.hoisted(() => vi.fn());
const mockAccess = vi.hoisted(() => ({
  status: "not_enrolled" as "not_enrolled" | "eligible",
  canUpload: false,
  refetch: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: { error: mockToastError } }));
vi.mock("@/features/quotes/use-founding-beta-access", () => ({
  useFoundingBetaAccess: () => mockAccess,
}));

function renderComposer(onSubmit = vi.fn()) {
  render(
    <TooltipProvider>
      <PromptComposer
        isSignedIn
        isVerifiedAuth
        organizationId="org-1"
        userId="user-1"
        onSubmit={onSubmit}
      />
    </TooltipProvider>,
  );
  return onSubmit;
}

describe("PromptComposer Founding Beta guard", () => {
  beforeEach(() => {
    mockToastError.mockReset();
    mockAccess.status = "not_enrolled";
    mockAccess.canUpload = false;
    mockAccess.refetch.mockReset().mockImplementation(async () => ({
      data: { state: mockAccess.status },
      isError: false,
    }));
  });

  it("blocks text-only creation while leaving the draft in place", async () => {
    const onSubmit = renderComposer();
    const textarea = screen.getByPlaceholderText("Ask anything");
    fireEvent.change(textarea, { target: { value: "Need ten brackets" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith(expect.stringContaining("invitation required")));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(textarea).toHaveValue("Need ten brackets");
  });

  it("submits the same draft after access becomes eligible", async () => {
    mockAccess.status = "eligible";
    mockAccess.canUpload = true;
    const onSubmit = renderComposer();
    const textarea = screen.getByPlaceholderText("Ask anything");
    fireEvent.change(textarea, { target: { value: "Need ten brackets" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      prompt: "Need ten brackets",
      files: [],
    })));
  });

  it("refreshes and explains a revocation that races the server write", async () => {
    mockAccess.status = "eligible";
    mockAccess.canUpload = true;
    mockAccess.refetch
      .mockResolvedValueOnce({ data: { state: "eligible" }, isError: false })
      .mockResolvedValue({ data: { state: "revoked" }, isError: false });
    const onSubmit = vi.fn().mockRejectedValue(
      new Error("Founding Beta access and current notice acceptance are required."),
    );
    renderComposer(onSubmit);
    const textarea = screen.getByPlaceholderText("Ask anything");
    fireEvent.change(textarea, { target: { value: "Need ten brackets" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith(
      expect.stringContaining("New drafts and uploads are paused"),
    ));
    expect(mockAccess.refetch).toHaveBeenCalledTimes(2);
  });

  it("keeps cached eligible drafts blocked when the access refetch fails", async () => {
    mockAccess.status = "eligible";
    mockAccess.canUpload = true;
    mockAccess.refetch.mockResolvedValue({ data: { state: "eligible" }, isError: true });
    const onSubmit = renderComposer();
    const textarea = screen.getByPlaceholderText("Ask anything");
    fireEvent.change(textarea, { target: { value: "Need ten brackets" } });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith(
      expect.stringContaining("could not be verified"),
    ));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(textarea).toHaveValue("Need ten brackets");
  });
});
