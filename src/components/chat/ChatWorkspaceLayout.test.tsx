import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatWorkspaceLayout } from "./ChatWorkspaceLayout";

const DESKTOP_SIDEBAR_COLLAPSED_STORAGE_KEY = "chat-workspace-layout.desktop-collapsed-v1";

function renderLayout() {
  return render(
    <ChatWorkspaceLayout sidebarContent={<div>Sidebar</div>} onLogoClick={vi.fn()}>
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

    expect(aside).toHaveStyle({ width: "52px" });
  });

  it("renders the collapsed rail logo without the decorative tile and keeps the open control accessible", () => {
    localStorage.setItem(DESKTOP_SIDEBAR_COLLAPSED_STORAGE_KEY, "1");

    const { container } = renderLayout();
    const aside = container.querySelector("aside");
    const collapsedRail = container.querySelector(".group.cursor-e-resize");

    expect(collapsedRail).not.toBeNull();

    const logo = within(collapsedRail as HTMLElement).getByAltText("OverDrafter logo");
    const openButton = within(collapsedRail as HTMLElement).getByRole("button", { name: /open sidebar/i });

    expect(aside).toHaveStyle({ width: "52px" });
    expect(logo).toBeInTheDocument();
    expect(logo.closest("div")).not.toHaveClass("bg-white/[0.03]");
    expect(openButton).toBeInTheDocument();
    expect(openButton).toHaveAttribute("aria-expanded", "false");
  });

  it("renders the main header brand outside the sidebar and omits sidebar brand text", () => {
    const { container } = renderLayout();
    const aside = container.querySelector("aside");
    const header = container.querySelector("header");
    const headerLeftGroup = header?.firstElementChild?.nextElementSibling ?? header?.firstElementChild;
    const sidebarHeader = aside?.querySelector(".chatgpt-shell > div:first-child");
    const sidebarLogoButton = screen.getByRole("button", { name: /overdrafter home/i });

    const visibleHeaderLogo = screen.getAllByAltText("OverDrafter logo")[0];
    const headerBrand = within(header as HTMLElement).getByText("OverDrafter");

    expect(visibleHeaderLogo).toBeInTheDocument();
    expect(visibleHeaderLogo.closest("div")).not.toHaveClass("bg-white/[0.03]");
    expect(header).toHaveTextContent("OverDrafter");
    expect(headerBrand.closest("button")).not.toBeNull();
    expect(headerLeftGroup).toHaveClass("flex", "items-center");
    expect(within(headerLeftGroup as HTMLElement).getByText("OverDrafter")).toBeInTheDocument();
    expect(sidebarHeader).toHaveClass("pl-2", "pr-2");
    expect(sidebarLogoButton).toHaveClass("h-9", "w-9");
    expect(aside).not.toHaveTextContent("v0.0.1");
    expect(aside).not.toHaveTextContent(/^OverDrafter$/);
  });

  it("persists the collapsed state when the desktop sidebar is closed", () => {
    const { container } = renderLayout();

    const closeButton = screen.getByRole("button", { name: /close sidebar/i });

    expect(closeButton).toHaveAttribute("aria-label", "Close sidebar");

    fireEvent.click(closeButton);

    const aside = container.querySelector("aside");

    expect(aside).toHaveStyle({ width: "52px" });
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
