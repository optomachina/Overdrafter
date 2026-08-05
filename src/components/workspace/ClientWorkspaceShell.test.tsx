import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Search, SquarePlus } from "lucide-react";
import { beforeEach, describe, expect, it } from "vitest";
import { ClientWorkspaceShell } from "./ClientWorkspaceShell";

describe("ClientWorkspaceShell", () => {
  beforeEach(() => {
    globalThis.localStorage.clear();
  });

  it("keeps the primary viewport shrinkable while exposing a sidebar resize handle", () => {
    render(
      <ClientWorkspaceShell sidebarContent={<div>Sidebar</div>}>
        <div>Primary workspace</div>
      </ClientWorkspaceShell>,
    );

    expect(screen.getByRole("separator", { name: "Resize sidebar" })).toHaveAttribute(
      "aria-orientation",
      "vertical",
    );

    const primaryViewport = screen.getByRole("main");
    expect(primaryViewport).toHaveClass("min-w-0");
    expect(primaryViewport.parentElement).toHaveClass("min-w-0");
  });

  it("uses the same horizontal inset rhythm on the expanded sidebar header", () => {
    render(
      <ClientWorkspaceShell sidebarContent={<div>Sidebar</div>}>
        <div>Primary workspace</div>
      </ClientWorkspaceShell>,
    );

    const closeSidebarButton = screen.getByRole("button", { name: "Close sidebar" });
    const headerRow = closeSidebarButton.parentElement;

    expect(headerRow).toHaveClass("px-2");
    expect(headerRow).not.toHaveClass("pl-2.5", "pr-2");
  });

  it("keeps the favicon mark on the same icon axis in both sidebar layers", () => {
    const { container } = render(
      <ClientWorkspaceShell
        sidebarContent={<div>Sidebar</div>}
        sidebarRailActions={[
          { label: "New Job", icon: SquarePlus, onClick: () => undefined },
          { label: "Search", icon: Search, onClick: () => undefined },
        ]}
      >
        <div>Primary workspace</div>
      </ClientWorkspaceShell>,
    );

    const closeSidebarButton = screen.getByRole("button", { name: "Close sidebar" });
    const headerRow = closeSidebarButton.parentElement;
    const expandedLogo = headerRow?.querySelector("svg[data-overdrafter-mark]");
    const sidebar = screen.getByRole("complementary");
    const persistentMark = container.querySelector('[data-sidebar-layer="persistent"] svg[data-overdrafter-mark]');

    expect(sidebar).toHaveAttribute("data-state", "expanded");
    expect(expandedLogo).toHaveAttribute("aria-hidden", "true");
    expect(expandedLogo).toHaveClass("text-foreground/95");

    fireEvent.click(closeSidebarButton);

    expect(sidebar).toHaveAttribute("data-state", "collapsed");
    expect(sidebar).toHaveStyle({ width: "52px" });
    expect(container.querySelector('[data-sidebar-layer="persistent"]')).toBeInTheDocument();
    expect(container.querySelector('[data-sidebar-layer="persistent"] svg[data-overdrafter-mark]')).toBe(persistentMark);
    expect(container.querySelector('[data-sidebar-layer="expanded"]')).toHaveClass("left-0");
    expect(container.querySelectorAll("svg[data-overdrafter-mark]")).toHaveLength(2);

    const newJobButton = screen.getByRole("button", { name: "New Job" });
    expect(newJobButton.parentElement).toHaveClass("gap-3");
    expect(newJobButton.parentElement?.parentElement).toHaveClass("gap-3");
  });
});
