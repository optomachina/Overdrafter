import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QuoteIntelligenceShell } from "./QuoteIntelligenceShell";

const originalMatchMedia = globalThis.window.matchMedia;

function renderShell(
  props: Partial<React.ComponentProps<typeof QuoteIntelligenceShell>> = {},
  initialEntry = "/parts",
) {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <QuoteIntelligenceShell title="Parts" {...props}>
        <p>Part collection</p>
      </QuoteIntelligenceShell>
    </MemoryRouter>,
  );
}

describe("QuoteIntelligenceShell", () => {
  beforeEach(() => {
    globalThis.localStorage.clear();
  });

  afterEach(() => {
    Object.defineProperty(globalThis.window, "matchMedia", {
      configurable: true,
      value: originalMatchMedia,
    });
  });

  it("uses one fixed application frame, page header, and primary workspace scroll owner", () => {
    const { container } = renderShell();

    const shell = container.querySelector("[data-client-shell]");
    const header = screen.getByRole("banner");
    const workspace = screen.getByRole("main");

    expect(shell).toHaveClass("h-svh", "overflow-hidden");
    expect(header).toHaveClass("h-14", "shrink-0");
    expect(screen.getByRole("heading", { name: "Parts", level: 1 })).toBeInTheDocument();
    expect(workspace).toHaveAttribute("data-workspace-scroll", "primary");
    expect(workspace).toHaveClass("min-h-0", "min-w-0", "overflow-y-auto");
    expect(container.querySelectorAll('[data-workspace-scroll="primary"]')).toHaveLength(1);
  });

  it("keeps the same navigation icon nodes mounted at 52px and 224px sidebar widths", () => {
    renderShell();

    const sidebar = screen.getByRole("complementary");
    const partsIcon = document.querySelector('svg[data-navigation-icon="Parts"]');
    const quotesIcon = document.querySelector('svg[data-navigation-icon="Quotes"]');
    const searchIcon = document.querySelector('svg[data-navigation-icon="Search"]');

    expect(sidebar).toHaveAttribute("data-state", "expanded");
    expect(sidebar).toHaveStyle({ width: "224px" });
    expect(partsIcon).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Parts" })).toHaveAttribute("aria-current", "page");

    fireEvent.click(screen.getByRole("button", { name: "Close sidebar" }));

    expect(sidebar).toHaveAttribute("data-state", "collapsed");
    expect(sidebar).toHaveStyle({ width: "52px" });
    expect(document.querySelector('svg[data-navigation-icon="Parts"]')).toBe(partsIcon);
    expect(document.querySelector('svg[data-navigation-icon="Quotes"]')).toBe(quotesIcon);
    expect(document.querySelector('svg[data-navigation-icon="Search"]')).toBe(searchIcon);
    expect(screen.getByRole("button", { name: "Open sidebar" })).toHaveAttribute("aria-expanded", "false");
  });

  it("provides a shrink-safe 336px inspector only when inspector content exists", () => {
    const { container } = renderShell({
      inspector: <div>Requirements</div>,
      inspectorTitle: "Part info",
    });

    const inspector = container.querySelector('[data-workspace-inspector="desktop"]');
    const workspace = screen.getByRole("main");

    expect(inspector).toHaveStyle({ width: "336px" });
    expect(inspector).toHaveClass("shrink-0", "xl:flex");
    expect(inspector).toHaveAccessibleName("Part info");
    expect(workspace).toHaveClass("min-w-0", "flex-1");
    expect(screen.getByRole("button", { name: "Open inspector" })).toHaveClass("xl:hidden");
  });

  it("uses a phone navigation drawer instead of a persistent visible icon rail", () => {
    Object.defineProperty(globalThis.window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockReturnValue({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    });

    renderShell();

    expect(screen.getByRole("complementary")).toHaveClass("hidden", "md:block");
    fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));

    expect(screen.getByRole("navigation", { name: "Primary" })).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toHaveClass("shadow-none");
    expect(screen.getByRole("dialog")).toHaveStyle({ width: "224px" });
  });

  it("keeps the native iOS shell free of web navigation chrome", () => {
    renderShell({}, "/parts?app=ios");

    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open navigation" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "OverDrafter" })).toHaveAttribute("href", "/parts?app=ios");
  });

  it("restores the persisted desktop preference after a narrow viewport", () => {
    globalThis.localStorage.setItem("workspace-shell.desktop-collapsed-v1", "0");
    let viewportChangeListener: ((event: MediaQueryListEvent) => void) | undefined;
    const narrowMediaQuery = {
      matches: false,
      addEventListener: vi.fn((_type: string, listener: (event: MediaQueryListEvent) => void) => {
        viewportChangeListener = listener;
      }),
      removeEventListener: vi.fn(),
    };
    const wideMediaQuery = {
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    Object.defineProperty(globalThis.window, "matchMedia", {
      configurable: true,
      value: vi.fn((query: string) => query.includes("max-width") ? narrowMediaQuery : wideMediaQuery),
    });

    renderShell();
    const sidebar = screen.getByRole("complementary");

    expect(sidebar).toHaveStyle({ width: "224px" });

    narrowMediaQuery.matches = true;
    act(() => viewportChangeListener?.({ matches: true } as MediaQueryListEvent));
    expect(sidebar).toHaveStyle({ width: "52px" });
    expect(globalThis.localStorage.getItem("workspace-shell.desktop-collapsed-v1")).toBe("0");

    narrowMediaQuery.matches = false;
    act(() => viewportChangeListener?.({ matches: false } as MediaQueryListEvent));
    expect(sidebar).toHaveStyle({ width: "224px" });
    expect(globalThis.localStorage.getItem("workspace-shell.desktop-collapsed-v1")).toBe("0");
  });
});
