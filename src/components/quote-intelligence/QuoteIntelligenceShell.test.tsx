import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QuoteIntelligenceShell } from "./QuoteIntelligenceShell";

const originalMatchMedia = globalThis.window.matchMedia;

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

  it("uses a persistent left navigation rail for the desktop workspace", () => {
    const { container } = render(
      <MemoryRouter initialEntries={["/parts"]}>
        <QuoteIntelligenceShell title="Parts">
          <p>Part collection</p>
        </QuoteIntelligenceShell>
      </MemoryRouter>,
    );

    const navigation = screen.getByRole("navigation", { name: "Primary" });
    expect(navigation).toHaveClass("flex-col");
    expect(screen.getByRole("link", { name: "Parts" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: "OverDrafter home" }).closest("aside")).toBeInTheDocument();
    const shell = container.firstElementChild;
    const sidebar = screen.getByRole("complementary");

    expect(shell).toHaveStyle({ paddingLeft: "224px" });
    expect(sidebar).toHaveAttribute("data-state", "expanded");
    expect(sidebar).toHaveStyle({ width: "224px" });
    expect(screen.getByRole("button", { name: "Close sidebar" })).toBeInTheDocument();
    const persistentMark = sidebar.querySelector("svg[data-overdrafter-mark]");
    expect(persistentMark).toBeInTheDocument();
    expect(screen.getAllByRole("navigation", { name: "Primary" })).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Close sidebar" }));

    expect(shell).toHaveStyle({ paddingLeft: "52px" });
    expect(sidebar).toHaveAttribute("data-state", "collapsed");
    expect(sidebar).toHaveStyle({ width: "52px" });
    expect(screen.getByRole("button", { name: "Open sidebar" })).toHaveAttribute("aria-expanded", "false");
    expect(sidebar.querySelector("svg[data-overdrafter-mark]")).toBe(persistentMark);
  });

  it("keeps the native iOS shell free of web navigation chrome", () => {
    render(
      <MemoryRouter initialEntries={["/parts?app=ios"]}>
        <QuoteIntelligenceShell title="Parts">
          <p>Part collection</p>
        </QuoteIntelligenceShell>
      </MemoryRouter>,
    );

    expect(screen.queryByRole("navigation", { name: "Primary" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "OverDrafter" })).toHaveAttribute("href", "/parts?app=ios");
  });

  it("defaults the web sidebar to its icon rail on narrow viewports", () => {
    Object.defineProperty(globalThis.window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockReturnValue({ matches: true }),
    });

    const { container } = render(
      <MemoryRouter initialEntries={["/parts"]}>
        <QuoteIntelligenceShell title="Parts">
          <p>Part collection</p>
        </QuoteIntelligenceShell>
      </MemoryRouter>,
    );

    expect(container.firstElementChild).toHaveStyle({ paddingLeft: "52px" });
    expect(screen.getByRole("complementary")).toHaveAttribute("data-state", "collapsed");
    expect(screen.getByRole("button", { name: "Open sidebar" })).toBeInTheDocument();
  });
});
