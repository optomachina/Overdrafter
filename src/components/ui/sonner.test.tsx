import "@testing-library/jest-dom/vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sonnerMock = vi.hoisted(() => {
  const errorImpl = vi.fn();
  return {
    errorImpl,
  };
});

vi.mock("next-themes", () => ({
  useTheme: () => ({
    theme: "light",
  }),
}));

vi.mock("@/lib/diagnostics", () => ({
  copyTextToClipboard: vi.fn(() => Promise.resolve()),
  createToastClipboardText: vi.fn((message: string) => `payload:${message}`),
}));

vi.mock("sonner", () => {
  const toast = {
    error: sonnerMock.errorImpl,
  };

  return {
    Toaster: () => null,
    toast,
  };
});

describe("sonner error toast defaults", () => {
  beforeEach(() => {
    sonnerMock.errorImpl.mockClear();
  });

  it("keeps error toasts open until dismissed while preserving explicit overrides", async () => {
    const { toast } = await import("sonner");
    await import("./sonner");

    toast.error("Persistent failure");
    expect(sonnerMock.errorImpl).toHaveBeenNthCalledWith(
      1,
      "Persistent failure",
      expect.objectContaining({
        duration: Number.POSITIVE_INFINITY,
        closeButton: true,
        dismissible: true,
        action: expect.objectContaining({
          label: expect.any(Object),
        }),
      }),
    );

    toast.error("Timed failure", {
      duration: 5000,
      closeButton: false,
      dismissible: false,
    });
    expect(sonnerMock.errorImpl).toHaveBeenNthCalledWith(
      2,
      "Timed failure",
      expect.objectContaining({
        duration: 5000,
        closeButton: false,
        dismissible: false,
        action: expect.objectContaining({
          label: expect.any(Object),
        }),
      }),
    );

    const retryAction = {
      label: "Retry",
      onClick: vi.fn(),
    };
    toast.error("Retryable failure", {
      action: retryAction,
    });
    expect(sonnerMock.errorImpl).toHaveBeenNthCalledWith(
      3,
      "Retryable failure",
      expect.objectContaining({
        action: retryAction,
        cancel: expect.objectContaining({
          label: expect.any(Object),
        }),
      }),
    );
  });

  it("normalizes object-shaped error messages before rendering", async () => {
    const { toast } = await import("sonner");
    await import("./sonner");
    const emitObjectError = toast.error as unknown as (message: unknown) => void;

    emitObjectError({ message: "Storage denied" });
    emitObjectError({});
    emitObjectError({ __isStorageError: true, name: "StorageUnknownError" });
    emitObjectError(Object.assign(new Error("{}"), { name: "StorageUnknownError", originalError: {} }));

    expect(sonnerMock.errorImpl).toHaveBeenNthCalledWith(
      1,
      "Storage denied",
      expect.objectContaining({
        action: expect.objectContaining({
          label: expect.any(Object),
        }),
      }),
    );
    expect(sonnerMock.errorImpl).toHaveBeenNthCalledWith(
      2,
      "Error toast triggered.",
      expect.objectContaining({
        action: expect.objectContaining({
          label: expect.any(Object),
        }),
      }),
    );
    expect(sonnerMock.errorImpl).toHaveBeenNthCalledWith(
      3,
      "Error toast triggered.",
      expect.objectContaining({
        action: expect.objectContaining({
          label: expect.any(Object),
        }),
      }),
    );
    expect(sonnerMock.errorImpl).toHaveBeenNthCalledWith(
      4,
      "Error toast triggered.",
      expect.objectContaining({
        action: expect.objectContaining({
          label: expect.any(Object),
        }),
      }),
    );
  });
});
