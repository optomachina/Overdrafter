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
