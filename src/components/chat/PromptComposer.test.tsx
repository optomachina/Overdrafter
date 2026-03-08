import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PromptComposer } from "./PromptComposer";

const toastError = vi.fn();

vi.mock("sonner", () => ({
  toast: {
    error: (...args: unknown[]) => toastError(...args),
  },
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: PropsWithChildren) => <>{children}</>,
  TooltipTrigger: ({ children }: PropsWithChildren) => <>{children}</>,
  TooltipContent: () => null,
}));

describe("PromptComposer", () => {
  beforeEach(() => {
    toastError.mockReset();
  });

  it("requires content before submitting", async () => {
    const onSubmit = vi.fn();

    render(<PromptComposer isSignedIn onSubmit={onSubmit} />);

    fireEvent.keyDown(screen.getByPlaceholderText("Ask anything"), {
      key: "Enter",
      code: "Enter",
    });

    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith("Please enter details or upload files.");
    });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("routes signed-out submissions to auth instead of calling onSubmit", () => {
    const onRequireAuth = vi.fn();
    const onSubmit = vi.fn();

    render(<PromptComposer isSignedIn={false} onRequireAuth={onRequireAuth} onSubmit={onSubmit} />);

    fireEvent.change(screen.getByPlaceholderText("Ask anything"), {
      target: { value: "Quote this bracket" },
    });
    fireEvent.click(screen.getAllByRole("button")[1]);

    expect(onRequireAuth).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("surfaces submit failures from the composer", async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error("Upload failed."));

    render(<PromptComposer isSignedIn onSubmit={onSubmit} />);

    fireEvent.change(screen.getByPlaceholderText("Ask anything"), {
      target: { value: "Please quote this part" },
    });
    fireEvent.click(screen.getAllByRole("button")[1]);

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith("Upload failed.");
    });
  });

  it("rejects unsupported uploaded file types", async () => {
    render(<PromptComposer isSignedIn onSubmit={vi.fn()} />);

    const fileInput = screen.getByLabelText("Upload files");
    const invalidFile = new File(["demo"], "notes.txt", { type: "text/plain" });

    fireEvent.change(fileInput, {
      target: { files: [invalidFile] },
    });

    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith("notes.txt is not a supported CNC upload type.");
    });
  });
});
