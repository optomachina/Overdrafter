import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PartDropdownMenuActions } from "@/components/chat/PartActionsMenu";
import { DropdownMenu, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

function renderMenu(props: Partial<ComponentProps<typeof PartDropdownMenuActions>> = {}) {
  return render(
    <DropdownMenu open>
      <DropdownMenuTrigger asChild>
        <button type="button">Open menu</button>
      </DropdownMenuTrigger>
      <PartDropdownMenuActions
        onEditPart={vi.fn()}
        addableProjects={[]}
        removableProjects={[]}
        onAddToProject={vi.fn()}
        pinLabel="Pin"
        onTogglePin={vi.fn()}
        {...props}
      />
    </DropdownMenu>,
  );
}

function openAddToProjectSubmenu() {
  const addToProjectTrigger = screen.getByText("Add to project");
  fireEvent.pointerMove(addToProjectTrigger);
  fireEvent.keyDown(addToProjectTrigger, { key: "ArrowRight" });
}

describe("PartActionsMenu", () => {
  beforeEach(() => {
    vi.stubGlobal("PointerEvent", MouseEvent);
  });

  it("shows create project in the add-to-project submenu when no other projects are available", async () => {
    const onCreateProject = vi.fn();

    renderMenu({
      onCreateProject,
    });

    openAddToProjectSubmenu();

    const createProjectItem = await screen.findByText("Create new project");
    fireEvent.click(createProjectItem);

    expect(onCreateProject).toHaveBeenCalledTimes(1);
  });

  it("keeps the empty-state message when project creation is unavailable", async () => {
    renderMenu();

    openAddToProjectSubmenu();

    await waitFor(() => {
      expect(screen.getByText("No other projects available")).toBeInTheDocument();
    });
  });
});
