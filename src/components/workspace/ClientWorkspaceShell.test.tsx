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
});
