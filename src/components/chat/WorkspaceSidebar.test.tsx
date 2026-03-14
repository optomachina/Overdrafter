import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceSidebar, type WorkspaceSidebarProject } from "@/components/chat/WorkspaceSidebar";
import type { JobPartSummary, JobRecord } from "@/features/quotes/types";

function makeJob(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "job-1",
    organization_id: "org-1",
    project_id: "project-1",
    selected_vendor_quote_offer_id: null,
    created_by: "user-1",
    title: "Job One",
    description: null,
    status: "uploaded",
    source: "client_home",
    active_pricing_policy_id: null,
    tags: [],
    requested_service_kinds: ["manufacturing_quote"],
    primary_service_kind: "manufacturing_quote",
    service_notes: null,
    requested_quote_quantities: [1],
    requested_by_date: null,
    archived_at: null,
    created_at: "2026-03-05T12:00:00.000Z",
    updated_at: "2026-03-05T12:30:00.000Z",
    ...overrides,
  };
}

function makeSummary(overrides: Partial<JobPartSummary> = {}): JobPartSummary {
  return {
    jobId: "job-1",
    partNumber: "1093-00001",
    revision: "A",
    description: "Part description",
    requestedServiceKinds: ["manufacturing_quote"],
    primaryServiceKind: "manufacturing_quote",
    serviceNotes: null,
    quantity: 1,
    requestedQuoteQuantities: [1],
    requestedByDate: null,
    importedBatch: null,
    selectedSupplier: null,
    selectedPriceUsd: null,
    selectedLeadTimeBusinessDays: null,
    ...overrides,
  };
}

describe("WorkspaceSidebar", () => {
  beforeEach(() => {
    vi.stubGlobal("PointerEvent", MouseEvent);

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
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const projects: WorkspaceSidebarProject[] = [
    {
      id: "project-1",
      name: "Project One",
      partCount: 2,
      canManage: true,
      createdAt: "2026-03-05T08:00:00.000Z",
      updatedAt: "2026-03-05T10:00:00.000Z",
    },
    {
      id: "project-2",
      name: "Project Two",
      partCount: 1,
      canManage: true,
      createdAt: "2026-03-04T08:00:00.000Z",
      updatedAt: "2026-03-04T10:00:00.000Z",
    },
  ];

  const jobs = [
    makeJob({
      id: "job-1",
      title: "Job One",
      created_at: "2026-03-05T12:00:00.000Z",
      updated_at: "2026-03-05T12:30:00.000Z",
    }),
    makeJob({
      id: "job-2",
      project_id: "project-1",
      title: "Job Two",
      created_at: "2026-03-05T11:00:00.000Z",
      updated_at: "2026-03-05T11:30:00.000Z",
    }),
    makeJob({
      id: "job-3",
      project_id: null,
      title: "Job Three",
      created_at: "2026-03-05T10:00:00.000Z",
      updated_at: "2026-03-05T10:30:00.000Z",
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
    [
      "job-3",
      makeSummary({
        jobId: "job-3",
        partNumber: "1093-00003",
      }),
    ],
  ]);

  function renderSidebar(overrides: Partial<React.ComponentProps<typeof WorkspaceSidebar>> = {}) {
    return render(
      <WorkspaceSidebar
        projects={projects}
        jobs={jobs}
        summariesByJobId={summariesByJobId}
        onSelectProject={vi.fn()}
        onSelectPart={vi.fn()}
        resolveProjectIdsForJob={(job) => {
          if (job.id === "job-1") {
            return ["project-1", "project-2"];
          }

          return job.project_id ? [job.project_id] : [];
        }}
        {...overrides}
      />,
    );
  }

  it("renders the top actions and project header actions", () => {
    renderSidebar({
      storageScopeKey: "sidebar-tests",
      onCreateJob: vi.fn(),
      onCreateProject: vi.fn(),
      onSearch: vi.fn(),
    });

    const newJobButton = screen.getByRole("button", { name: /new job/i });
    const newProjectButton = screen.getByRole("button", { name: /new project/i });
    const searchButton = screen.getByRole("button", { name: /^search$/i });
    const collapseProjectsButton = screen.getByRole("button", { name: /collapse projects/i });
    const collapsePartsButton = screen.getByRole("button", { name: /collapse parts/i });
    const sortAndFilterButton = screen.getByRole("button", { name: /sort and filter sidebar/i });

    expect(newJobButton).toBeInTheDocument();
    expect(newProjectButton).toBeInTheDocument();
    expect(searchButton).toBeInTheDocument();
    expect(collapseProjectsButton).toHaveTextContent("Projects");
    expect(collapsePartsButton).toHaveTextContent("Parts");
    expect(sortAndFilterButton).toBeInTheDocument();
    expect(newJobButton).toHaveClass("text-white/[0.94]");
    expect(searchButton).toHaveClass("text-white/[0.94]");
    expect(newJobButton).toHaveClass("pl-1", "pr-3");
    expect(searchButton).toHaveClass("pl-1", "pr-3");
  });

  it("invokes the project header create action", () => {
    const sharedCreateHandler = vi.fn();

    renderSidebar({
      onCreateJob: sharedCreateHandler,
      onCreateProject: sharedCreateHandler,
    });

    fireEvent.click(screen.getByRole("button", { name: /new job/i }));
    fireEvent.click(screen.getByRole("button", { name: /new project/i }));

    expect(sharedCreateHandler).toHaveBeenCalledTimes(2);
  });

  it("uses the brighter row icon treatment for project and part entries", () => {
    const { container } = renderSidebar();
    const folderIcon = container.querySelector(".lucide-folder");
    const partIcon = container.querySelector(".lucide-shapes");
    const projectRow = screen.getAllByRole("button", { name: /project one/i })[0];
    const partRow = screen.getByRole("button", { name: /1093-00003/i });

    expect(folderIcon).toHaveClass("text-white/[0.9]");
    expect(partIcon).toHaveClass("text-white/[0.9]");
    expect(projectRow).toHaveClass("px-2", "py-2");
    expect(partRow).toHaveClass("px-2", "py-2");
  });

  it("prefetches a project on hover and focus", async () => {
    vi.useFakeTimers();
    const onPrefetchProject = vi.fn();

    renderSidebar({
      onPrefetchProject,
    });

    const projectRow = screen.getAllByRole("button", { name: /project one/i })[0];

    fireEvent.pointerEnter(projectRow);
    await act(async () => {
      vi.advanceTimersByTime(80);
    });
    fireEvent.focus(projectRow);
    await act(async () => {
      vi.advanceTimersByTime(80);
    });

    expect(onPrefetchProject).toHaveBeenNthCalledWith(1, "project-1");
    expect(onPrefetchProject).toHaveBeenNthCalledWith(2, "project-1");
  });

  it("prefetches a part before navigation on pointer down", () => {
    const onPrefetchPart = vi.fn();

    renderSidebar({
      onPrefetchPart,
    });

    const partRow = screen.getByRole("button", { name: /1093-00003/i });
    fireEvent.pointerDown(partRow, { button: 0 });

    expect(onPrefetchPart).toHaveBeenCalledWith("job-3");
  });

  it("shows only ungrouped parts in the flat parts section", () => {
    renderSidebar();

    expect(screen.getByRole("button", { name: /1093-00003/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /1093-00001/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /1093-00002/i })).not.toBeInTheDocument();
  });

  it("restores expanded project state from local storage", () => {
    localStorage.setItem(
      "workspace-sidebar-expanded-v1:sidebar-expanded",
      JSON.stringify({ "project-1": true }),
    );

    renderSidebar({
      storageScopeKey: "sidebar-expanded",
    });

    expect(screen.getAllByText(/1093-00001/i).length).toBeGreaterThan(0);
  });

  it("shows grouped parts only inside expanded projects, including multi-project jobs", () => {
    localStorage.setItem(
      "workspace-sidebar-expanded-v1:sidebar-grouped-parts",
      JSON.stringify({ "project-1": true, "project-2": true }),
    );

    renderSidebar({
      storageScopeKey: "sidebar-grouped-parts",
    });

    expect(screen.getAllByText(/1093-00001/i)).toHaveLength(2);
    expect(screen.getAllByText(/1093-00002/i)).toHaveLength(1);
    expect(screen.getByRole("button", { name: /1093-00003/i })).toBeInTheDocument();
  });

  it("keeps grouped pinned parts out of the parts section in pinned mode", async () => {
    renderSidebar({
      pinnedJobIds: ["job-1", "job-3"],
    });

    const filterButton = screen.getByRole("button", { name: /sort and filter sidebar/i });

    fireEvent.pointerDown(filterButton, { button: 0 });
    fireEvent.click(await screen.findByRole("menuitem", { name: /pinned/i }));
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /1093-00003/i })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /1093-00001/i })).not.toBeInTheDocument();
    });
  });

  it("treats resolved project memberships as grouped even without job.project_id", () => {
    renderSidebar({
      projects: [
        {
          id: "seed-qb00001",
          name: "QB00001",
          partCount: 1,
          isReadOnly: true,
        },
      ],
      jobs: [
        makeJob({
          id: "job-seeded",
          project_id: null,
          title: "Seeded Job",
        }),
      ],
      summariesByJobId: new Map([
        [
          "job-seeded",
          makeSummary({
            jobId: "job-seeded",
            partNumber: "1093-00010",
          }),
        ],
      ]),
      resolveProjectIdsForJob: () => ["seed-qb00001"],
    });

    expect(screen.queryByRole("button", { name: /1093-00010/i })).not.toBeInTheDocument();
  });

  it("collapses and persists the projects and parts sections", () => {
    renderSidebar({
      storageScopeKey: "sidebar-sections",
    });

    fireEvent.click(screen.getByRole("button", { name: /collapse projects/i }));
    expect(screen.queryByText("Project Two")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /collapse parts/i }));
    expect(screen.queryByText(/1093-00003/i)).not.toBeInTheDocument();

    expect(JSON.parse(localStorage.getItem("workspace-sidebar-sections-v1:sidebar-sections") ?? "{}")).toEqual({
      projects: false,
      parts: false,
    });

    fireEvent.click(screen.getByRole("button", { name: /expand projects/i }));
    expect(screen.getByText("Project Two")).toBeInTheDocument();
  });

  it("shows project context menu actions", () => {
    renderSidebar({
      onRenameProject: vi.fn(),
      onArchiveProject: vi.fn(),
      onDissolveProject: vi.fn(),
    });

    fireEvent.contextMenu(screen.getAllByText("Project One")[0]!);

    expect(screen.getByText("Edit project")).toBeInTheDocument();
    expect(screen.getByText("Pin")).toBeInTheDocument();
    expect(screen.getByText("Edit project name")).toBeInTheDocument();
    expect(screen.getByText("Archive Project")).toBeInTheDocument();
    expect(screen.getByText("Dissolve project")).toBeInTheDocument();
  });

  it("shows Archive Project for seeded batch rows", () => {
    renderSidebar({
      projects: [
        {
          id: "seed-qb00001",
          name: "QB00001",
          partCount: 1,
          isReadOnly: true,
          roleLabel: "batch",
        },
      ],
      jobs: [
        makeJob({
          id: "job-seeded",
          project_id: null,
          source: "spreadsheet_import:qb00001:1093-00010:a",
        }),
      ],
      summariesByJobId: new Map([
        [
          "job-seeded",
          makeSummary({
            jobId: "job-seeded",
            importedBatch: "QB00001",
          }),
        ],
      ]),
      resolveProjectIdsForJob: () => ["seed-qb00001"],
      onArchiveProject: vi.fn(),
    });

    fireEvent.contextMenu(screen.getAllByText("QB00001")[0]!);

    expect(screen.getByText("Archive Project")).toBeInTheDocument();
  });

  it("shows the shared part actions in the part context menu", () => {
    renderSidebar({
      onRenamePart: vi.fn(),
      onAssignPartToProject: vi.fn(),
      onRemovePartFromProject: vi.fn(),
      onArchivePart: vi.fn(),
    });

    fireEvent.contextMenu(screen.getByText(/1093-00003/i));

    expect(screen.getByText("Edit part")).toBeInTheDocument();
    expect(screen.getByText("Rename part")).toBeInTheDocument();
    expect(screen.getByText("Add to project")).toBeInTheDocument();
    expect(screen.getByText("Archive part")).toBeInTheDocument();
    expect(screen.getByText("Pin")).toBeInTheDocument();
  });

  it("keeps part pinning in the context menu only", () => {
    renderSidebar();

    expect(screen.queryByRole("button", { name: /pin part/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /unpin part/i })).not.toBeInTheDocument();

    fireEvent.contextMenu(screen.getByText(/1093-00003/i));

    expect(screen.getByText("Pin")).toBeInTheDocument();
  });

  it("invokes archive and dissolve handlers from project actions", () => {
    const onArchiveProject = vi.fn();
    const onDissolveProject = vi.fn();

    renderSidebar({
      onArchiveProject,
      onDissolveProject,
    });

    act(() => {
      fireEvent.contextMenu(screen.getAllByText("Project One")[0]!);
    });
    act(() => {
      fireEvent.click(screen.getByText("Archive Project"));
    });
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    });
    expect(onArchiveProject).toHaveBeenCalledWith("project-1");

    act(() => {
      fireEvent.contextMenu(screen.getAllByText("Project One")[0]!);
    });
    act(() => {
      fireEvent.click(screen.getByText("Dissolve project"));
    });
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Dissolve" }));
    });
    expect(onDissolveProject).toHaveBeenCalledWith("project-1");
  });

  it("mirrors part selection across duplicate rows", () => {
    localStorage.setItem(
      "workspace-sidebar-expanded-v1:sidebar-selection",
      JSON.stringify({ "project-1": true, "project-2": true }),
    );

    renderSidebar({
      storageScopeKey: "sidebar-selection",
    });

    fireEvent.click(screen.getAllByText(/1093-00001/i)[0]!);

    const selectedRows = screen
      .getAllByText(/1093-00001/i)
      .map((element) => element.closest('[role="button"]'))
      .filter((row): row is HTMLElement => Boolean(row));

    expect(selectedRows).toHaveLength(2);
    selectedRows.forEach((row) => {
      expect(row).toHaveClass("bg-white/[0.08]");
    });
  });

  it("supports shift-range selection and batch project creation", async () => {
    const onCreateProjectFromSelection = vi.fn();

    renderSidebar({
      jobs: [
        makeJob({
          id: "job-1",
          project_id: null,
          title: "Job One",
          created_at: "2026-03-05T12:00:00.000Z",
          updated_at: "2026-03-05T12:30:00.000Z",
        }),
        makeJob({
          id: "job-2",
          project_id: null,
          title: "Job Two",
          created_at: "2026-03-05T11:00:00.000Z",
          updated_at: "2026-03-05T11:30:00.000Z",
        }),
        makeJob({
          id: "job-3",
          project_id: null,
          title: "Job Three",
          created_at: "2026-03-05T10:00:00.000Z",
          updated_at: "2026-03-05T10:30:00.000Z",
        }),
      ],
      onCreateProjectFromSelection,
      resolveProjectIdsForJob: () => [],
    });

    await act(async () => {
      fireEvent.click(screen.getByText(/1093-00001/i));
    });

    await act(async () => {
      fireEvent.click(screen.getByText(/1093-00003/i), { shiftKey: true });
    });

    await act(async () => {
      fireEvent.contextMenu(screen.getByText(/1093-00003/i));
    });

    const createProjectItem = await screen.findByText("Create new project");

    await act(async () => {
      fireEvent.click(createProjectItem);
    });

    expect(onCreateProjectFromSelection).toHaveBeenCalledTimes(1);
    expect(onCreateProjectFromSelection).toHaveBeenCalledWith(["job-1", "job-2", "job-3"]);
  });

  it("creates a project from a single part context menu when no addable projects exist", async () => {
    const onCreateProjectFromSelection = vi.fn();

    renderSidebar({
      projects: [],
      jobs: [
        makeJob({
          id: "job-3",
          project_id: null,
          title: "Job Three",
          created_at: "2026-03-05T10:00:00.000Z",
          updated_at: "2026-03-05T10:30:00.000Z",
        }),
      ],
      summariesByJobId: new Map([
        [
          "job-3",
          makeSummary({
            jobId: "job-3",
            partNumber: "1093-00003",
          }),
        ],
      ]),
      onAssignPartToProject: vi.fn(),
      onCreateProjectFromSelection,
      resolveProjectIdsForJob: () => [],
    });

    await act(async () => {
      fireEvent.contextMenu(screen.getByText(/1093-00003/i));
    });

    await act(async () => {
      const addToProjectTrigger = screen.getByText((content, element) => {
        return content.includes("Add to project") && element?.getAttribute("role") === "menuitem";
      });
      fireEvent.pointerMove(addToProjectTrigger);
      fireEvent.keyDown(addToProjectTrigger, { key: "ArrowRight" });
    });

    const createProjectItem = await screen.findByText("Create new project");

    await act(async () => {
      fireEvent.click(createProjectItem);
    });

    expect(onCreateProjectFromSelection).toHaveBeenCalledTimes(1);
    expect(onCreateProjectFromSelection).toHaveBeenCalledWith(["job-3"]);
  });

  it("removes a nested part from the specific project it was opened under", async () => {
    const onRemovePartFromProject = vi.fn();

    localStorage.setItem(
      "workspace-sidebar-expanded-v1:sidebar-removal",
      JSON.stringify({ "project-1": true, "project-2": true }),
    );

    renderSidebar({
      storageScopeKey: "sidebar-removal",
      onRemovePartFromProject,
    });

    await act(async () => {
      fireEvent.contextMenu(screen.getAllByText(/1093-00001/i)[1]!);
    });

    await act(async () => {
      fireEvent.click(screen.getByText("Remove from this project"));
    });

    expect(onRemovePartFromProject).toHaveBeenCalledWith("job-1", "project-2");
  });
});
