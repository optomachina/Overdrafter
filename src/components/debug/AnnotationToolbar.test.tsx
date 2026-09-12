import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AnnotationToolbar } from "./AnnotationToolbar";

const clicks = vi.hoisted(() => vi.fn());
vi.mock("agentation", async () => {
  const { createPortal } = await import("react-dom");
  return { Agentation: ({ className }: { className: string }) => createPortal(
    <div className={className}>
      <div role="button" tabIndex={0} onClick={clicks}>Launcher</div>
      <button role="button" tabIndex={0} onClick={clicks}>Native control</button>
      <textarea aria-label="Annotation text" />
    </div>, document.body,
  ) };
});
afterEach(() => { cleanup(); });

function setup() {
  const view = render(<StrictMode><AnnotationToolbar /></StrictMode>);
  const launcher = screen.getByRole("button", { name: "Launcher" });
  launcher.focus();
  return { view, launcher };
}

describe("annotation keyboard bridge", () => {
  it("activates Enter exactly once and ignores repeats", () => {
    const { launcher } = setup();
    expect(fireEvent.keyDown(launcher, { key: "Enter" })).toBe(false);
    fireEvent.keyDown(launcher, { key: "Enter", repeat: true });
    fireEvent.keyUp(launcher, { key: "Enter" });
    expect(clicks).toHaveBeenCalledTimes(1);
  });

  it("prevents Space scrolling and activates only once on release", () => {
    const { launcher } = setup();
    expect(fireEvent.keyDown(launcher, { key: " " })).toBe(false);
    expect(fireEvent.keyDown(launcher, { key: " ", repeat: true })).toBe(false);
    expect(clicks).not.toHaveBeenCalled();
    expect(fireEvent.keyUp(launcher, { key: " " })).toBe(false);
    fireEvent.keyUp(launcher, { key: " " });
    expect(clicks).toHaveBeenCalledTimes(1);
  });

  it("cancels a pending Space when focus leaves or Escape is pressed", () => {
    const { launcher } = setup();
    fireEvent.keyDown(launcher, { key: " " });
    screen.getByRole("textbox").focus();
    launcher.focus();
    fireEvent.keyUp(launcher, { key: " " });
    fireEvent.keyDown(launcher, { key: " " });
    fireEvent.keyDown(launcher, { key: "Escape" });
    fireEvent.keyUp(launcher, { key: " " });
    expect(clicks).not.toHaveBeenCalled();
  });

  it("does not intercept native controls, text inputs or unfocused launchers", () => {
    const { launcher } = setup();
    for (const target of [screen.getByRole("button", { name: "Native control" }), screen.getByRole("textbox")]) {
      target.focus();
      for (const key of ["Enter", " "]) {
        expect(fireEvent.keyDown(target, { key })).toBe(true);
        expect(fireEvent.keyUp(target, { key })).toBe(true);
      }
    }
    expect(fireEvent.keyDown(launcher, { key: "Enter" })).toBe(true);
    expect(clicks).not.toHaveBeenCalled();
  });

  it("respects modifiers, composition and already-handled keyboard events", () => {
    const { launcher } = setup();
    for (const options of [{ ctrlKey: true }, { altKey: true }, { metaKey: true }, { shiftKey: true }, { isComposing: true }]) {
      expect(fireEvent.keyDown(launcher, { key: "Enter", ...options })).toBe(true);
    }
    const handled = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    handled.preventDefault();
    fireEvent(launcher, handled);
    expect(clicks).not.toHaveBeenCalled();
  });

  it("retains ordinary pointer delivery", () => {
    const { launcher } = setup();
    fireEvent.click(launcher);
    expect(clicks).toHaveBeenCalledTimes(1);
  });

  it("removes pending activation on unmount and installs only one bridge on remount", () => {
    const { launcher, view } = setup();
    fireEvent.keyDown(launcher, { key: " " });
    view.unmount();
    fireEvent.keyUp(launcher, { key: " " });
    const next = setup();
    fireEvent.keyUp(next.launcher, { key: " " });
    expect(clicks).not.toHaveBeenCalled();
    fireEvent.keyDown(next.launcher, { key: "Enter" });
    expect(clicks).toHaveBeenCalledTimes(1);
  });
});
