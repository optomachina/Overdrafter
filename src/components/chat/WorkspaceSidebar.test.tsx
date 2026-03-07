import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceSidebar, type WorkspaceSidebarProject } from "./WorkspaceSidebar";
import type { JobPartSummary, JobRecord } from "@/features/quotes/types";

function makeJob(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "job-1",
    organization_id: "org-1",
    project_id: "project-1",
    created_by: "user-1",
    title: "Job One",
    description: null,
    status: "uploaded",
    source: "client_home",
    active_pricing_policy_id: null,
    tags: [],
    created_at: "2026-03-05T09:00:00.000Z",
    updated_at: "2026-03-05T10:00:00.000Z",
    ...overrides,
  };
}

function makeSummary(overrides: Partial<JobPartSummary> = {}): JobPartSummary {
  return {
    jobId: "job-1",
    partNumber: "1093-00001",
    revision: "A",
    description: "Part description",
    quantity: 1,
    importedBatch: null,
    ...overrides,
  };
}

describe("WorkspaceSidebar", () => {
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

  const projects: WorkspaceSidebarProject[] = [
    {
      id: "project-1",
      name: "Project One",
      partCount: 1,
      canManage: true,
      createdAt: "2026-03-05T08:00:00.000Z",
      updatedAt: "2026-03-05T10:00:00.000Z",
    },
    {
      id: "project-2",
      name: "Project Two",
      partCount: 0,
      canManage: true,
      createdAt: "2026-03-04T08:00:00.000Z",
      updatedAt: "2026-03-04T10:00:00.000Z",
    },
  ];

  const jobs = [
    makeJob(),
    makeJob({
      id: "job-2",
      project_id: null,
      title: "Ungrouped Job",
      created_at: "2026-03-05T11:00:00.000Z",
      updated_at: "2026-03-05T11:30:00.000Z",
    }),
  ];

  const summariesByJobId = new Map<string, JobPartSummary>([
    ["job-1", makeSummary()],
    [
      "job-2",
      makeSummary({
        jobId: "job-2",
        partNumber: "1093-00002",
      }),
    ],
  ]);

  it("renders the top actions and section headings", () => {
    render(
      <WorkspaceSidebar
        projects={projects}
        jobs={jobs}
        summariesByJobId={summariesByJobId}
        storageScopeKey="sidebar-tests"
        onCreateJob={vi.fn()}
        onSearch={vi.fn()}
        onCreateProject={vi.fn()}
        onSelectProject={vi.fn()}
        onSelectPart={vi.fn()}
      />,
    );

    const newJobButton = screen.getByRole("button", { name: /new job/i });
    const searchButton = screen.getByRole("button", { name: /^search$/i });
    const [newJobIconSlot] = newJobButton.querySelectorAll("span");
    const [searchIconSlot] = searchButton.querySelectorAll("span");

    expect(screen.queryByText("Threads")).not.toBeInTheDocument();
    expect(newJobButton).toBeInTheDocument();
    expect(newJobButton).not.toHaveClass("border");
    expect(newJobIconSlot).toHaveClass("w-5");
    expect(searchButton).toBeInTheDocument();
    expect(searchButton).not.toHaveClass("border");
    expect(searchIconSlot).toHaveClass("w-5");
    expect(screen.getByText("Projects")).toBeInTheDocument();
    expect(screen.getByText("Parts")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /new project/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /filter parts/i })).toBeInTheDocument();
  });


  it("fires create project callback", () => {
    const onCreateProject = vi.fn();

    render(
      <WorkspaceSidebar
        projects={projects}
        jobs={jobs}
        summariesByJobId={summariesByJobId}
        onCreateProject={onCreateProject}
        onSelectProject={vi.fn()}
        onSelectPart={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /new project/i }));

    expect(onCreateProject).toHaveBeenCalledTimes(1);
  });

  it("restores expanded project state from local storage", () => {
    localStorage.setItem(
      "workspace-sidebar-expanded-v1:sidebar-expanded",
      JSON.stringify({ "project-1": true }),
    );

    render(
      <WorkspaceSidebar
        projects={projects}
        jobs={jobs}
        summariesByJobId={summariesByJobId}
        storageScopeKey="sidebar-expanded"
        onSelectProject={vi.fn()}
        onSelectPart={vi.fn()}
      />,
    );

    expect(screen.getAllByText(/1093-00001/i).length).toBeGreaterThan(0);
  });

  it("collapses and persists the projects and parts sections", () => {
    render(
      <WorkspaceSidebar
        projects={projects}
        jobs={jobs}
        summariesByJobId={summariesByJobId}
        storageScopeKey="sidebar-sections"
        onSelectProject={vi.fn()}
        onSelectPart={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /collapse projects/i }));
    expect(screen.queryByText("Project Two")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /collapse parts/i }));
    expect(screen.queryByText(/1093-00002/i)).not.toBeInTheDocument();

    expect(JSON.parse(localStorage.getItem("workspace-sidebar-sections-v1:sidebar-sections") ?? "{}")).toEqual({
      projects: false,
      parts: false,
    });

    fireEvent.click(screen.getByRole("button", { name: /expand projects/i }));
    expect(screen.getByText("Project Two")).toBeInTheDocument();
  });

  it("shows project context menu actions", () => {
    const onRenameProject = vi.fn();
    const onDeleteProject = vi.fn();

    render(
      <WorkspaceSidebar
        projects={projects}
        jobs={jobs}
        summariesByJobId={summariesByJobId}
        onRenameProject={onRenameProject}
        onDeleteProject={onDeleteProject}
        onSelectProject={vi.fn()}
        onSelectPart={vi.fn()}
      />,
    );

    fireEvent.contextMenu(screen.getAllByText("Project One")[0]);

    expect(screen.getByText("Edit project")).toBeInTheDocument();
    expect(screen.getByText("Pin")).toBeInTheDocument();
    expect(screen.getByText("Edit project name")).toBeInTheDocument();
    expect(screen.getByText("Delete")).toBeInTheDocument();
  });

  it("shows part context menu project actions", () => {
    const onAssignPartToProject = vi.fn();
    const onRemovePartFromProject = vi.fn();

    render(
      <WorkspaceSidebar
        projects={projects}
        jobs={jobs}
        summariesByJobId={summariesByJobId}
        activeProjectId="project-1"
        onAssignPartToProject={onAssignPartToProject}
        onRemovePartFromProject={onRemovePartFromProject}
        onSelectProject={vi.fn()}
        onSelectPart={vi.fn()}
      />,
    );

    fireEvent.contextMenu(screen.getByText(/1093-00001/i));

    expect(screen.getByText("Add to project")).toBeInTheDocument();
    expect(screen.getByText("Remove from project")).toBeInTheDocument();
  });
});
