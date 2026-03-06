import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ProjectNameDialog } from "./ProjectNameDialog";

describe("ProjectNameDialog", () => {
  it("submits from the form without requiring a button click", () => {
    const onSubmit = vi.fn();

    render(
      <ProjectNameDialog
        open
        onOpenChange={vi.fn()}
        title="Create project"
        description="Projects are shareable by default."
        value="Fixture project"
        onValueChange={vi.fn()}
        submitLabel="Create"
        onSubmit={onSubmit}
      />,
    );

    const form = screen.getByPlaceholderText("Project name").closest("form");

    expect(form).not.toBeNull();

    fireEvent.submit(form!);

    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("does not submit when the dialog is disabled", () => {
    const onSubmit = vi.fn();

    render(
      <ProjectNameDialog
        open
        onOpenChange={vi.fn()}
        title="Rename project"
        description="Update the project name."
        value="Project One"
        onValueChange={vi.fn()}
        submitLabel="Save"
        isSubmitDisabled
        onSubmit={onSubmit}
      />,
    );

    fireEvent.submit(screen.getByPlaceholderText("Project name").closest("form")!);

    expect(onSubmit).not.toHaveBeenCalled();
  });
});
