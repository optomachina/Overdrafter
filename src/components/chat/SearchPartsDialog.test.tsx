import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SearchPartsDialog } from "./SearchPartsDialog";

vi.mock("@/components/ui/command", () => ({
  CommandDialog: ({ open, children }: PropsWithChildren<{ open: boolean }>) => (open ? <div>{children}</div> : null),
  CommandInput: ({
    value,
    onValueChange,
    placeholder,
  }: {
    value: string;
    onValueChange: (value: string) => void;
    placeholder: string;
  }) => <input aria-label={placeholder} value={value} onChange={(event) => onValueChange(event.target.value)} />,
  CommandList: ({ children }: PropsWithChildren) => <div>{children}</div>,
  CommandEmpty: ({ children }: PropsWithChildren) => <div>{children}</div>,
  CommandGroup: ({ heading, children }: PropsWithChildren<{ heading: string }>) => (
    <section>
      <h2>{heading}</h2>
      {children}
    </section>
  ),
  CommandItem: ({
    children,
    onSelect,
  }: PropsWithChildren<{ onSelect: () => void }>) => (
    <button type="button" onClick={onSelect}>
      {children}
    </button>
  ),
}));

function makeJob(id: string, title: string, description: string) {
  return {
    id,
    organization_id: "org-1",
    project_id: null,
    created_by: "user-1",
    title,
    description,
    status: "uploaded",
    source: "client_home",
    tags: [],
    active_pricing_policy_id: null,
    created_at: "2026-03-03T19:00:00Z",
    updated_at: "2026-03-03T19:00:00Z",
  };
}

describe("SearchPartsDialog", () => {
  const onOpenChange = vi.fn();
  const onSelectProject = vi.fn();
  const onSelectPart = vi.fn();

  beforeEach(() => {
    onOpenChange.mockReset();
    onSelectProject.mockReset();
    onSelectPart.mockReset();
  });

  it("filters projects and parts and routes selections to the correct callback", () => {
    render(
      <SearchPartsDialog
        open
        onOpenChange={onOpenChange}
        projects={[
          { id: "project-1", name: "Gearbox", partCount: 3 },
          { id: "project-2", name: "Housing", partCount: 1 },
        ]}
        jobs={[
          makeJob("job-1", "1093-00001", "Gear bracket"),
          makeJob("job-2", "1093-00002", "Motor plate"),
        ]}
        summariesByJobId={
          new Map([
            [
              "job-1",
              {
                jobId: "job-1",
                partNumber: "1093-00001",
                revision: "A",
                description: "Gear bracket",
                quantity: 1,
                importedBatch: null,
              },
            ],
            [
              "job-2",
              {
                jobId: "job-2",
                partNumber: "1093-00002",
                revision: "B",
                description: "Motor plate",
                quantity: 1,
                importedBatch: null,
              },
            ],
          ])
        }
        onSelectProject={onSelectProject}
        onSelectPart={onSelectPart}
      />,
    );

    fireEvent.change(screen.getByLabelText("Search parts and projects"), {
      target: { value: "gear" },
    });

    fireEvent.click(screen.getByRole("button", { name: /gearbox/i }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onSelectProject).toHaveBeenCalledWith("project-1");

    fireEvent.click(screen.getByRole("button", { name: /1093-00001/i }));
    expect(onSelectPart).toHaveBeenCalledWith("job-1");

    expect(screen.queryByRole("button", { name: /housing/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /1093-00002/i })).not.toBeInTheDocument();
  });
});
