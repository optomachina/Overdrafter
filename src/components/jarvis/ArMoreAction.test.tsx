import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ArMoreAction } from "./ArMoreAction";
import { model, ios } from "@/features/jarvis/ar/ar-fixtures";

afterEach(cleanup);
it("opens a labelled modal, contains focus and restores focus on every close path", () => {
  render(<ArMoreAction {...model} title="PLATE_R1" posterUrl="/plate.png" status="ready" onRetry={vi.fn()} device={ios} />);
  const more = screen.getByRole("button", { name: "MORE" });
  expect(more.getAttribute("aria-haspopup")).toBe("dialog");
  for (const close of ["cancel", "escape", "backdrop"]) {
    fireEvent.click(more);
    const dialog = screen.getByRole("dialog", { name: "PLATE_R1" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement).toBe(dialog);
    expect(more.getAttribute("aria-expanded")).toBe("true");
    const cancel = screen.getByRole("button", { name: "CANCEL" });
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(cancel);
    fireEvent.keyDown(cancel, { key: "Tab" });
    expect(document.activeElement).toBe(screen.getByRole("link", { name: "View in AR" }));
    fireEvent.click(dialog);
    expect(screen.getByRole("dialog")).toBe(dialog);
    if (close === "cancel") fireEvent.click(cancel);
    if (close === "escape") fireEvent.keyDown(dialog, { key: "Escape" });
    if (close === "backdrop") fireEvent.click(dialog.parentElement!);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(more);
    expect(more.getAttribute("aria-expanded")).toBe("false");
  }
});

it("keeps focus in the sheet when retry removes the focused button", () => {
  function RetrySheet() {
    const [status, setStatus] = useState<"failed" | "ready">("failed");
    return <ArMoreAction {...model} title="PLATE_R1" posterUrl="/plate.png" status={status} onRetry={() => setStatus("ready")} device={ios} />;
  }
  render(<RetrySheet />);
  const more = screen.getByRole("button", { name: "MORE" });
  fireEvent.click(more);
  const dialog = screen.getByRole("dialog", { name: "PLATE_R1" });
  const retry = screen.getByRole("button", { name: "TRY AGAIN" });
  retry.focus();
  fireEvent.click(retry);
  expect(dialog.contains(document.activeElement)).toBe(true);
  fireEvent.keyDown(document.activeElement!, { key: "Tab", shiftKey: true });
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "CANCEL" }));
  fireEvent.keyDown(document.activeElement!, { key: "Tab" });
  expect(document.activeElement).toBe(screen.getByRole("link", { name: "View in AR" }));
  // Document-level handling also recovers if focus lands outside the sheet.
  more.focus();
  more.blur();
  expect(document.activeElement).toBe(document.body);
  fireEvent.keyDown(document.body, { key: "Tab" });
  expect(document.activeElement).toBe(screen.getByRole("link", { name: "View in AR" }));
  more.focus();
  more.blur();
  fireEvent.keyDown(document.body, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(more);
});

it.each([
  { status: "loading" as const, device: ios, content: "Preparing AR view" },
  { status: "ready" as const, device: { ...ios, standalone: true }, content: "OPEN IN SAFARI" },
])("opens a labelled $status modal and restores focus on CANCEL", ({ status, device, content }) => {
  render(<ArMoreAction {...model} title="PLATE_R1" posterUrl="/plate.png" status={status} onRetry={vi.fn()} device={device} />);
  const more = screen.getByRole("button", { name: "MORE" });
  fireEvent.click(more);
  const dialog = screen.getByRole("dialog", { name: "PLATE_R1" });
  expect(dialog.getAttribute("aria-modal")).toBe("true");
  expect(document.activeElement).toBe(dialog);
  expect(screen.getByText(content)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "CANCEL" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(more);
});
