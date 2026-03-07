import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatWorkspaceLayout } from "./ChatWorkspaceLayout";

const DESKTOP_SIDEBAR_COLLAPSED_STORAGE_KEY = "chat-workspace-layout.desktop-collapsed-v1";

function renderLayout() {
  return render(
    <ChatWorkspaceLayout sidebarContent={<div>Sidebar</div>}>
      <div>Body</div>
    </ChatWorkspaceLayout>,
  );
}

describe("ChatWorkspaceLayout", () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    const localStorageMock = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
      clear: () => {
        store.clear();
      },
    };

    vi.stubGlobal("localStorage", localStorageMock);
    Object.defineProperty(window, "localStorage", {
      value: localStorageMock,
      writable: true,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("restores the narrower persisted collapsed rail width", () => {
    localStorage.setItem(DESKTOP_SIDEBAR_COLLAPSED_STORAGE_KEY, "1");

    const { container } = renderLayout();
    const aside = container.querySelector("aside");

    expect(aside).toHaveStyle({ width: "56px" });
  });

  it("persists the collapsed state when the desktop sidebar is closed", () => {
    const { container } = renderLayout();

    const closeButton = screen.getByRole("button", { name: /close sidebar/i });

    expect(closeButton).toHaveAttribute("aria-label", "Close sidebar");

    fireEvent.click(closeButton);

    const aside = container.querySelector("aside");

    expect(aside).toHaveStyle({ width: "56px" });
    expect(localStorage.getItem(DESKTOP_SIDEBAR_COLLAPSED_STORAGE_KEY)).toBe("1");
  });

  it("shows the close sidebar tooltip below the trigger on focus", () => {
    renderLayout();

    const closeButton = screen.getByRole("button", { name: /close sidebar/i });

    Object.defineProperty(closeButton, "getBoundingClientRect", {
      value: () => ({
        width: 36,
        height: 36,
        top: 12,
        right: 116,
        bottom: 48,
        left: 80,
        x: 80,
        y: 12,
        toJSON: () => "",
      }),
    });

    fireEvent.focus(closeButton);

    const tooltip = screen.getByRole("tooltip");

    expect(tooltip).toHaveTextContent("Close sidebar");
    expect(tooltip).toHaveStyle({ left: "98px", top: "62px" });

    fireEvent.blur(closeButton);

    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });
});
