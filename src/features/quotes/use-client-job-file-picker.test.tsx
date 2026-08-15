import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useClientJobFilePicker } from "./use-client-job-file-picker";

const mockToastError = vi.hoisted(() => vi.fn());
const mockAccess = vi.hoisted(() => ({
  status: "not_enrolled" as "not_enrolled" | "eligible" | "revoked",
  canUpload: false,
  refetch: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: { error: mockToastError } }));
vi.mock("@/features/quotes/use-founding-beta-access", () => ({
  useFoundingBetaAccess: () => mockAccess,
}));

describe("useClientJobFilePicker Founding Beta guard", () => {
  beforeEach(() => {
    mockToastError.mockReset();
    mockAccess.status = "not_enrolled";
    mockAccess.canUpload = false;
    mockAccess.refetch.mockReset().mockImplementation(async () => ({
      data: { state: mockAccess.status },
      isError: false,
    }));
  });

  it("does not open or hand off files while access is blocked", async () => {
    const onFilesSelected = vi.fn();
    const { result } = renderHook(() => useClientJobFilePicker({
      isSignedIn: true,
      isVerifiedAuth: true,
      organizationId: "org-target",
      userId: "user-1",
      onFilesSelected,
    }));
    const click = vi.fn();
    Object.defineProperty(result.current.inputRef, "current", {
      configurable: true,
      value: { click, value: "" },
    });

    await act(async () => result.current.openFilePicker());
    expect(click).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.handleFileInputChange({
        target: { files: [new File(["part"], "part.step") ] },
      } as never);
    });
    expect(onFilesSelected).not.toHaveBeenCalled();
    expect(mockToastError).toHaveBeenCalledWith(expect.stringContaining("invitation required"));
  });

  it("rechecks access after selection and catches a revocation", async () => {
    const onFilesSelected = vi.fn();
    mockAccess.status = "eligible";
    mockAccess.canUpload = true;
    const { result, rerender } = renderHook(() => useClientJobFilePicker({
      isSignedIn: true,
      isVerifiedAuth: true,
      organizationId: "org-target",
      userId: "user-1",
      onFilesSelected,
    }));
    const click = vi.fn();
    Object.defineProperty(result.current.inputRef, "current", {
      configurable: true,
      value: { click, value: "" },
    });
    await act(async () => result.current.openFilePicker());
    expect(click).toHaveBeenCalledOnce();

    mockAccess.status = "revoked";
    mockAccess.canUpload = false;
    rerender();
    await act(async () => {
      await result.current.handleFileInputChange({
        target: { files: [new File(["part"], "part.step")] },
      } as never);
    });
    expect(onFilesSelected).not.toHaveBeenCalled();
    expect(mockToastError).toHaveBeenCalledWith(expect.stringContaining("uploads are paused"));
  });

  it("does not trust cached eligible data when the access refetch fails", async () => {
    const onFilesSelected = vi.fn();
    mockAccess.status = "eligible";
    mockAccess.canUpload = true;
    mockAccess.refetch.mockResolvedValue({ data: { state: "eligible" }, isError: true });
    const { result } = renderHook(() => useClientJobFilePicker({
      isSignedIn: true,
      isVerifiedAuth: true,
      organizationId: "org-target",
      userId: "user-1",
      onFilesSelected,
    }));
    const click = vi.fn();
    Object.defineProperty(result.current.inputRef, "current", {
      configurable: true,
      value: { click, value: "" },
    });

    await act(async () => result.current.openFilePicker());

    expect(click).not.toHaveBeenCalled();
    expect(onFilesSelected).not.toHaveBeenCalled();
    expect(mockToastError).toHaveBeenCalledWith(expect.stringContaining("could not be verified"));
  });
});
