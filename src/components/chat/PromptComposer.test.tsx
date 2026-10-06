import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

type HeldRefetchResult = { data: { state: string }; isError: boolean };

/** Holds every access refetch open until the test releases it, reproducing a slow network check. */
function holdAccessRefetch() {
  const pending: Array<(result: HeldRefetchResult) => void> = [];
  mockAccess.refetch.mockImplementation(
    () => new Promise<HeldRefetchResult>((resolve) => {
      pending.push(resolve);
    }),
  );

  return {
    get pendingCount() {
      return pending.length;
    },
    release: async (state: string) => {
      await act(async () => {
        pending.splice(0).forEach((resolve) => resolve({ data: { state }, isError: false }));
      });
      await settle();
    },
  };
}

/** Lets every queued microtask (refetch continuation, onSubmit, finally) run before asserting. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function renderComposerWith({
  isSignedIn = true,
  isVerifiedAuth = true,
  onSubmit = vi.fn(),
}: {
  isSignedIn?: boolean;
  isVerifiedAuth?: boolean;
  onSubmit?: ReturnType<typeof vi.fn>;
} = {}) {
  const onRequireAuth = vi.fn();
  const { container } = render(
    <TooltipProvider>
      <PromptComposer
        isSignedIn={isSignedIn}
        isVerifiedAuth={isVerifiedAuth}
        organizationId="org-1"
        userId="user-1"
        onRequireAuth={onRequireAuth}
        onSubmit={onSubmit}
      />
    </TooltipProvider>,
  );
  const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]');
  if (!fileInput) {
    throw new Error("PromptComposer did not render its file input.");
  }

  return {
    onSubmit,
    onRequireAuth,
    fileInput,
    textarea: screen.getByPlaceholderText("Ask anything"),
  };
}

function makeStepFile(name = "bracket.step", lastModified = 1_700_000_000_000) {
  return new File(["solid bracket"], name, { type: "model/step", lastModified });
}

function stagedChips(fileName: string) {
  return screen.queryAllByRole("button", { name: `Remove ${fileName}` });
}

describe("PromptComposer reentrancy guards", () => {
  beforeEach(() => {
    mockToastError.mockReset();
    mockAccess.status = "eligible";
    mockAccess.canUpload = true;
    mockAccess.refetch.mockReset().mockImplementation(async () => ({
      data: { state: mockAccess.status },
      isError: false,
    }));
  });

  it("creates one draft when Enter is pressed twice during the access refetch", async () => {
    const refetch = holdAccessRefetch();
    const { onSubmit, textarea } = renderComposerWith();
    fireEvent.change(textarea, { target: { value: "Need ten brackets" } });

    fireEvent.keyDown(textarea, { key: "Enter" });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await refetch.release("eligible");

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ prompt: "Need ten brackets", files: [] }));
  });

  it("creates one draft when Enter is followed by a Submit click during the access refetch", async () => {
    const refetch = holdAccessRefetch();
    const { onSubmit, textarea } = renderComposerWith();
    fireEvent.change(textarea, { target: { value: "Need ten brackets" } });

    fireEvent.keyDown(textarea, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    await refetch.release("eligible");

    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("accepts a new submit after an eligible submit completes", async () => {
    const refetch = holdAccessRefetch();
    const { onSubmit, textarea } = renderComposerWith();
    fireEvent.change(textarea, { target: { value: "Need ten brackets" } });

    fireEvent.keyDown(textarea, { key: "Enter" });
    await refetch.release("eligible");
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(textarea).not.toBeDisabled();

    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(refetch.pendingCount).toBe(1);
    await refetch.release("eligible");

    expect(onSubmit).toHaveBeenCalledTimes(2);
  });

  it("accepts a later submit after the refetch reports the organization is not enrolled", async () => {
    const refetch = holdAccessRefetch();
    const { onSubmit, textarea } = renderComposerWith();
    fireEvent.change(textarea, { target: { value: "Need ten brackets" } });

    fireEvent.keyDown(textarea, { key: "Enter" });
    await refetch.release("not_enrolled");
    expect(mockToastError).toHaveBeenCalledWith(expect.stringContaining("invitation required"));
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(refetch.pendingCount).toBe(1);
    await refetch.release("eligible");

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(textarea).toHaveValue("Need ten brackets");
  });

  it("accepts a later submit after the previous submit rejects", async () => {
    const onSubmit = vi.fn()
      .mockRejectedValueOnce(new Error("Unable to submit this part right now."))
      .mockResolvedValue(undefined);
    const { textarea } = renderComposerWith({ onSubmit });
    fireEvent.change(textarea, { target: { value: "Need ten brackets" } });

    fireEvent.keyDown(textarea, { key: "Enter" });
    await settle();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(mockToastError).toHaveBeenCalledWith("Unable to submit this part right now.");

    fireEvent.keyDown(textarea, { key: "Enter" });
    await settle();
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });

  it("does not hold the guard after the empty-prompt early return", async () => {
    const { onSubmit, textarea } = renderComposerWith();

    fireEvent.keyDown(textarea, { key: "Enter" });
    await settle();
    expect(mockToastError).toHaveBeenCalledWith("Please enter details or upload files.");

    fireEvent.change(textarea, { target: { value: "Need ten brackets" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await settle();

    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("releases the guard after the unverified-email early return", async () => {
    const { onSubmit, textarea } = renderComposerWith({ isVerifiedAuth: false });
    fireEvent.change(textarea, { target: { value: "Need ten brackets" } });

    fireEvent.keyDown(textarea, { key: "Enter" });
    await settle();
    fireEvent.keyDown(textarea, { key: "Enter" });
    await settle();

    expect(mockToastError).toHaveBeenCalledTimes(2);
    expect(mockToastError).toHaveBeenNthCalledWith(2, "Please verify your email before creating a part.");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("releases the guard after the signed-out early return", async () => {
    const { onSubmit, onRequireAuth, textarea } = renderComposerWith({ isSignedIn: false });
    fireEvent.change(textarea, { target: { value: "Need ten brackets" } });

    fireEvent.keyDown(textarea, { key: "Enter" });
    await settle();
    fireEvent.keyDown(textarea, { key: "Enter" });
    await settle();

    expect(onRequireAuth).toHaveBeenCalledTimes(2);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("stages one chip when the same file is selected twice during the access refetch", async () => {
    const refetch = holdAccessRefetch();
    const { fileInput } = renderComposerWith();
    const file = makeStepFile();

    fireEvent.change(fileInput, { target: { files: [file] } });
    fireEvent.change(fileInput, { target: { files: [file] } });
    await refetch.release("eligible");

    expect(stagedChips("bracket.step")).toHaveLength(1);
  });

  it("stages both files when two different files are selected during the access refetch", async () => {
    const refetch = holdAccessRefetch();
    const { fileInput } = renderComposerWith();

    fireEvent.change(fileInput, { target: { files: [makeStepFile("bracket.step")] } });
    fireEvent.change(fileInput, { target: { files: [makeStepFile("housing.step")] } });
    await refetch.release("eligible");

    expect(stagedChips("bracket.step")).toHaveLength(1);
    expect(stagedChips("housing.step")).toHaveLength(1);
  });

  it("stages one chip when one batch repeats the same file", async () => {
    const { fileInput } = renderComposerWith();
    const file = makeStepFile();
    const sameNameSizeAndDate = makeStepFile();

    fireEvent.change(fileInput, { target: { files: [file, file, sameNameSizeAndDate] } });
    await settle();

    expect(stagedChips("bracket.step")).toHaveLength(1);
    expect(mockToastError).not.toHaveBeenCalled();
  });

  it("opens the file picker once when Upload is clicked twice during the access refetch", async () => {
    const refetch = holdAccessRefetch();
    const { fileInput } = renderComposerWith();
    const openPicker = vi.spyOn(fileInput, "click").mockImplementation(() => undefined);
    const uploadButton = screen.getByRole("button", { name: "Upload files" });

    fireEvent.click(uploadButton);
    fireEvent.click(uploadButton);
    await refetch.release("eligible");

    expect(openPicker).toHaveBeenCalledTimes(1);

    fireEvent.click(uploadButton);
    await refetch.release("eligible");

    expect(openPicker).toHaveBeenCalledTimes(2);
  });
});

const SHARED_LAST_MODIFIED = 1_700_000_000_000;

/** Same name, byte length and mtime; only the bytes differ, as with two files from different folders. */
function makeSameMetadataFile(contents: string) {
  return new File([contents], "bracket.step", { type: "model/step", lastModified: SHARED_LAST_MODIFIED });
}

/** Waits until the staged-file digest work has run, then lets its state update settle. */
async function settleDigests(digest: { mock: { results: Array<{ value: unknown }> } }, expectedCalls: number) {
  await waitFor(() => expect(digest.mock.results.length).toBeGreaterThanOrEqual(expectedCalls));
  await act(async () => {
    await Promise.allSettled(digest.mock.results.map((result) => result.value));
  });
  await settle();
  await settle();
}

describe("PromptComposer staged-file content dedupe", () => {
  beforeEach(() => {
    mockToastError.mockReset();
    mockAccess.status = "eligible";
    mockAccess.canUpload = true;
    mockAccess.refetch.mockReset().mockImplementation(async () => ({
      data: { state: mockAccess.status },
      isError: false,
    }));
  });

  it("keeps both files when a second selection matches name, size and mtime but has different bytes", async () => {
    const { fileInput } = renderComposerWith();
    const first = makeSameMetadataFile("solid bracket A");
    const second = makeSameMetadataFile("solid bracket B");
    expect(second.size).toBe(first.size);

    fireEvent.change(fileInput, { target: { files: [first] } });
    await settle();
    fireEvent.change(fileInput, { target: { files: [second] } });

    await waitFor(() => expect(stagedChips("bracket.step")).toHaveLength(2));
    expect(mockToastError).not.toHaveBeenCalled();
  });

  it("keeps both files when one batch holds two same-metadata files with different bytes", async () => {
    const { fileInput } = renderComposerWith();

    fireEvent.change(fileInput, {
      target: { files: [makeSameMetadataFile("solid bracket A"), makeSameMetadataFile("solid bracket B")] },
    });

    await waitFor(() => expect(stagedChips("bracket.step")).toHaveLength(2));
  });

  it("submits both same-metadata files with different bytes", async () => {
    const { fileInput, onSubmit } = renderComposerWith();
    const first = makeSameMetadataFile("solid bracket A");
    const second = makeSameMetadataFile("solid bracket B");

    fireEvent.change(fileInput, { target: { files: [first, second] } });
    await waitFor(() => expect(stagedChips("bracket.step")).toHaveLength(2));
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0].files).toEqual([first, second]);
  });

  it("still stages one chip when a separate selection has the same metadata and the same bytes", async () => {
    const digest = vi.spyOn(crypto.subtle, "digest");
    const { fileInput } = renderComposerWith();

    fireEvent.change(fileInput, { target: { files: [makeSameMetadataFile("solid bracket A")] } });
    await settle();
    fireEvent.change(fileInput, { target: { files: [makeSameMetadataFile("solid bracket A")] } });
    await settleDigests(digest, 2);

    expect(stagedChips("bracket.step")).toHaveLength(1);
  });

  it("does not read file contents when the metadata differs", async () => {
    const digest = vi.spyOn(crypto.subtle, "digest");
    const { fileInput } = renderComposerWith();

    fireEvent.change(fileInput, {
      target: { files: [makeStepFile("bracket.step"), makeStepFile("bracket.step", SHARED_LAST_MODIFIED + 1)] },
    });
    fireEvent.change(fileInput, { target: { files: [makeStepFile("housing.step")] } });
    await settle();

    expect(stagedChips("bracket.step")).toHaveLength(2);
    expect(stagedChips("housing.step")).toHaveLength(1);
    expect(digest).not.toHaveBeenCalled();
  });

  it("keeps a same-metadata file when its contents cannot be digested", async () => {
    const digest = vi.spyOn(crypto.subtle, "digest").mockRejectedValue(new Error("NotReadableError"));
    const { fileInput } = renderComposerWith();

    fireEvent.change(fileInput, { target: { files: [makeSameMetadataFile("solid bracket A")] } });
    await settle();
    // Same bytes, but without a digest the composer cannot prove it, so it must keep the file.
    fireEvent.change(fileInput, { target: { files: [makeSameMetadataFile("solid bracket A")] } });

    await waitFor(() => expect(stagedChips("bracket.step")).toHaveLength(2));
    expect(digest).toHaveBeenCalled();
  });

  it("keeps a same-metadata file when reading its bytes fails", async () => {
    const { fileInput } = renderComposerWith();
    const unreadable = makeSameMetadataFile("solid bracket A");
    const readBytes = vi.fn().mockRejectedValue(new Error("NotReadableError"));
    Object.defineProperty(unreadable, "arrayBuffer", { value: readBytes });

    fireEvent.change(fileInput, { target: { files: [makeSameMetadataFile("solid bracket A")] } });
    await settle();
    fireEvent.change(fileInput, { target: { files: [unreadable] } });

    await waitFor(() => expect(stagedChips("bracket.step")).toHaveLength(2));
    expect(readBytes).toHaveBeenCalled();
  });
});
