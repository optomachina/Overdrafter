import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ClientWorkspaceShell } from "./ClientWorkspaceShell";

describe("ClientWorkspaceShell", () => {
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

  it("applies a small visual offset to the expanded sidebar logo mark", () => {
    render(
      <ClientWorkspaceShell sidebarContent={<div>Sidebar</div>}>
        <div>Primary workspace</div>
      </ClientWorkspaceShell>,
    );

    const closeSidebarButton = screen.getByRole("button", { name: "Close sidebar" });
    const headerRow = closeSidebarButton.parentElement;
    const expandedLogo = headerRow?.querySelector('img[alt="OverDrafter logo"]');

    expect(expandedLogo).toHaveClass("translate-x-[5px]");
  });
});
