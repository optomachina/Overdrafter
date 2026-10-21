import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import JarvisArPreview from "./JarvisArPreview";
import posterUrl from "@/features/jarvis/ar/preview-assets/plate-thumb.png";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it("keeps AR inside MORE with a thumbnail and restores focus after CANCEL", () => {
  vi.spyOn(window.navigator, "userAgent", "get").mockReturnValue("iPhone Safari");
  vi.spyOn(DOMTokenList.prototype, "supports").mockReturnValue(true);
  render(<JarvisArPreview />);
  expect(screen.getByRole("link", { name: "OPEN 3D" })).toBeTruthy();
  expect(screen.queryByRole("dialog")).toBeNull();
  const more = screen.getByRole("button", { name: "MORE" });
  fireEvent.click(more);
  expect(screen.getByRole("dialog", { name: "PLATE_R1" })).toBeTruthy();
  const image = screen.getByRole("link", { name: "View in AR" }).querySelector("img");
  expect(image?.getAttribute("src")).toBe(posterUrl);
  expect(image?.getAttribute("src")).not.toBe("/placeholder.svg");
  fireEvent.click(screen.getByRole("button", { name: "CANCEL" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(more);
});
it("previews loading and failure with retry returning to ready", () => {
  render(<JarvisArPreview />);
  fireEvent.click(screen.getByRole("radio", { name: "LOADING" }));
  fireEvent.click(screen.getByRole("button", { name: "MORE" }));
  expect(screen.getByRole("status").textContent).toBe("Preparing AR view");
  fireEvent.click(screen.getByRole("button", { name: "CANCEL" }));
  fireEvent.click(screen.getByRole("radio", { name: "FAILED" }));
  fireEvent.click(screen.getByRole("button", { name: "MORE" }));
  fireEvent.click(screen.getByRole("button", { name: "TRY AGAIN" }));
  expect(screen.queryByRole("button", { name: "TRY AGAIN" })).toBeNull();
  expect((screen.getByRole("radio", { name: "READY" }) as HTMLInputElement).checked).toBe(true);
});
