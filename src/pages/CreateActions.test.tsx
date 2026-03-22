import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { forwardRef, type PropsWithChildren, type ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ClientHome from "./ClientHome";
import ClientPart from "./ClientPart";
import ClientProject from "./ClientProject";

const { mockUseAppSession, mockOpenFilePicker, mockHandleFileInputChange, mockUseClientJobFilePicker, api, toastMock } =
  vi.hoisted(() => ({
    mockUseAppSession: vi.fn(),
    mockOpenFilePicker: vi.fn(),
    mockHandleFileInputChange: vi.fn(),
    mockUseClientJobFilePicker: vi.fn(),
    api: {
      archiveJob: vi.fn(),
      archiveProject: vi.fn(),
      assignJobToProject: vi.fn(),
      checkClientIntakeCompatibility: vi.fn().mockResolvedValue("available"),
      createClientDraft: vi.fn(),
      createJobsFromUploadFiles: vi.fn(),
      createProject: vi.fn(),
      createSelfServiceOrganization: vi.fn(),
      deleteArchivedJob: vi.fn(),
      deleteArchivedJobs: vi.fn(),
      dissolveProject: vi.fn(),
      fetchAccessibleJobs: vi.fn(),
      fetchAccessibleProjects: vi.fn(),
      fetchArchivedJobs: vi.fn(),
      fetchArchivedProjects: vi.fn(),
      fetchClientActivityEventsByJobIds: vi.fn(),
      fetchClientQuoteWorkspaceByJobIds: vi.fn(),
      fetchPartDetailByJobId: vi.fn(),
      fetchJobPartSummariesByJobIds: vi.fn(),
      fetchJobsByProject: vi.fn(),
      fetchProject: vi.fn(),
      fetchProjectInvites: vi.fn(),
      fetchProjectJobMembershipsByJobIds: vi.fn(),
      fetchProjectMemberships: vi.fn(),
      fetchSidebarPins: vi.fn(),
      getClientIntakeCompatibilityMessage: vi.fn(() => "compatibility ok"),
      inviteProjectMember: vi.fn(),
      isArchivedDeleteCapabilityError: vi.fn(() => false),
      isProjectNotFoundError: vi.fn(() => false),
      isProjectCollaborationSchemaUnavailable: vi.fn(),
      pinJob: vi.fn(),
      pinProject: vi.fn(),
      reconcileJobParts: vi.fn(),
      removeJobFromProject: vi.fn(),
      resolveClientPartDetailRoute: vi.fn(),
      removeProjectMember: vi.fn(),
      requestExtraction: vi.fn(),
      requestQuote: vi.fn(),
      requestQuotes: vi.fn(),
      resendSignupConfirmation: vi.fn(),
      setJobSelectedVendorQuoteOffer: vi.fn(),
      unarchiveJob: vi.fn(),
      unarchiveProject: vi.fn(),
      unpinJob: vi.fn(),
      unpinProject: vi.fn(),
      updateClientPartRequest: vi.fn(),
      updateProject: vi.fn(),
      uploadFilesToJob: vi.fn(),
    },
    toastMock: {
      error: vi.fn(),
      success: vi.fn(),
    },
  }));

vi.mock("@/hooks/use-app-session", () => ({
  useAppSession: () => mockUseAppSession(),
}));

vi.mock("@/features/quotes/api", () => api);
vi.mock("@/features/quotes/api/archive-api", () => ({
  archiveJob: api.archiveJob,
  deleteArchivedJobs: api.deleteArchivedJobs,
  isArchivedDeleteCapabilityError: api.isArchivedDeleteCapabilityError,
  unarchiveJob: api.unarchiveJob,
}));
vi.mock("@/features/quotes/api/compatibility-api", () => ({
  checkClientIntakeCompatibility: api.checkClientIntakeCompatibility,
  getClientIntakeCompatibilityMessage: api.getClientIntakeCompatibilityMessage,
}));
vi.mock("@/features/quotes/api/extraction-api", () => ({
  reconcileJobParts: api.reconcileJobParts,
  requestExtraction: api.requestExtraction,
}));
vi.mock("@/features/quotes/api/jobs-api", () => ({
  createClientDraft: api.createClientDraft,
  updateClientPartRequest: api.updateClientPartRequest,
}));
vi.mock("@/features/quotes/api/projects-api", () => ({
  archiveProject: api.archiveProject,
  assignJobToProject: api.assignJobToProject,
  createProject: api.createProject,
  dissolveProject: api.dissolveProject,
  fetchProject: api.fetchProject,
  fetchProjectInvites: api.fetchProjectInvites,
  fetchProjectMemberships: api.fetchProjectMemberships,
  inviteProjectMember: api.inviteProjectMember,
  pinJob: api.pinJob,
  pinProject: api.pinProject,
  removeJobFromProject: api.removeJobFromProject,
  removeProjectMember: api.removeProjectMember,
  unarchiveProject: api.unarchiveProject,
  unpinJob: api.unpinJob,
  unpinProject: api.unpinProject,
  updateProject: api.updateProject,
}));
vi.mock("@/features/quotes/api/quote-requests-api", () => ({
  requestQuote: api.requestQuote,
  requestQuotes: api.requestQuotes,
  setJobSelectedVendorQuoteOffer: api.setJobSelectedVendorQuoteOffer,
}));
vi.mock("@/features/quotes/api/session-access", () => ({
  createSelfServiceOrganization: api.createSelfServiceOrganization,
  resendSignupConfirmation: api.resendSignupConfirmation,
}));
vi.mock("@/features/quotes/api/shared/schema-runtime", () => ({
  isProjectCollaborationSchemaUnavailable: api.isProjectCollaborationSchemaUnavailable,
}));
vi.mock("@/features/quotes/api/uploads-api", () => ({
  createJobsFromUploadFiles: api.createJobsFromUploadFiles,
  uploadFilesToJob: api.uploadFilesToJob,
}));
vi.mock("@/features/quotes/api/workspace-access", () => ({
  fetchAccessibleJobs: api.fetchAccessibleJobs,
  fetchAccessibleProjects: api.fetchAccessibleProjects,
  fetchArchivedJobs: api.fetchArchivedJobs,
  fetchArchivedProjects: api.fetchArchivedProjects,
  fetchClientActivityEventsByJobIds: api.fetchClientActivityEventsByJobIds,
  fetchClientQuoteWorkspaceByJobIds: api.fetchClientQuoteWorkspaceByJobIds,
  fetchJobPartSummariesByJobIds: api.fetchJobPartSummariesByJobIds,
  fetchJobsByProject: api.fetchJobsByProject,
  fetchPartDetailByJobId: api.fetchPartDetailByJobId,
  fetchProject: api.fetchProject,
  fetchProjectJobMembershipsByJobIds: api.fetchProjectJobMembershipsByJobIds,
  fetchSidebarPins: api.fetchSidebarPins,
  isProjectNotFoundError: api.isProjectNotFoundError,
  resolveClientPartDetailRoute: api.resolveClientPartDetailRoute,
}));

vi.mock("sonner", () => ({
  toast: toastMock,
}));

vi.mock("@/features/quotes/use-client-job-file-picker", () => ({
  useClientJobFilePicker: (...args: unknown[]) => mockUseClientJobFilePicker(...args),
}));

vi.mock("@/components/workspace/ClientWorkspaceShell", () => ({
  ClientWorkspaceShell: ({
    sidebarContent,
    children,
  }: {
    sidebarContent?: ReactNode;
    children?: ReactNode;
  }) => (
    <div>
      <div>{sidebarContent}</div>
      <div>{children}</div>
    </div>
  ),
}));

vi.mock("@/components/chat/WorkspaceSidebar", () => ({
  WorkspaceSidebar: ({
    onCreateJob,
    onCreateProject,
    onArchiveProject,
    onArchivePart,
  }: {
    onCreateJob?: () => void;
    onCreateProject?: () => void;
    onArchiveProject?: (projectId: string) => void;
    onArchivePart?: (jobId: string) => void;
  }) => (
    <div>
      <button type="button" onClick={onCreateJob}>
        New Job
      </button>
      <button type="button" onClick={onCreateProject}>
        New Project
      </button>
      <button type="button" onClick={() => onArchiveProject?.("project-1")}>
        Archive Sidebar Project
      </button>
      <button type="button" onClick={() => onArchivePart?.("job-1")}>
        Archive Sidebar Part
      </button>
    </div>
  ),
}));

vi.mock("@/components/chat/PartActionsMenu", () => ({
  PartDropdownMenuActions: ({
    onEditPart,
    onRenamePart,
    onCreateProject,
    onArchivePart,
    onTogglePin,
    onAddToProject,
    onRemoveFromProject,
  }: {
    onEditPart: () => void;
    onRenamePart?: () => void;
    onCreateProject?: () => void;
    onArchivePart?: () => void;
    onTogglePin: () => void;
    onAddToProject?: (projectId: string) => void;
    onRemoveFromProject?: (projectId: string) => void;
  }) => (
    <div>
      <button type="button" onClick={onEditPart}>Edit part</button>
      {onRenamePart ? <button type="button" onClick={onRenamePart}>Rename part</button> : null}
      {onCreateProject ? <button type="button" onClick={onCreateProject}>Create new project</button> : null}
      {onAddToProject ? <button type="button" onClick={() => onAddToProject("project-2")}>Add to project</button> : null}
      {onRemoveFromProject ? <button type="button" onClick={() => onRemoveFromProject("project-1")}>Remove from project</button> : null}
      {onArchivePart ? <button type="button" onClick={onArchivePart}>Archive part</button> : null}
      <button type="button" onClick={onTogglePin}>Pin</button>
    </div>
  ),
}));


vi.mock("@/components/projects/ProjectNameDialog", () => ({
  ProjectNameDialog: ({
    open,
    title,
    value,
    onValueChange,
    onSubmit,
    submitLabel,
  }: {
    open: boolean;
    title: string;
    value: string;
    onValueChange: (value: string) => void;
    onSubmit: () => void;
    submitLabel: string;
  }) =>
    open ? (
      <div>
        <div>{title}</div>
        <input aria-label={title} value={value} onChange={(event) => onValueChange(event.target.value)} />
        <button type="button" onClick={onSubmit}>
          {submitLabel}
        </button>
      </div>
    ) : null,
}));

vi.mock("@/components/chat/WorkspaceAccountMenu", () => ({
  WorkspaceAccountMenu: () => null,
}));

vi.mock("@/components/chat/GuestSidebarCta", () => ({
  GuestSidebarCta: () => null,
}));

vi.mock("@/components/chat/PromptComposer", () => ({
  PromptComposer: forwardRef<HTMLTextAreaElement>((_, ref) => <textarea ref={ref} />),
}));

vi.mock("@/components/chat/SearchPartsDialog", () => ({
  SearchPartsDialog: () => null,
}));

vi.mock("@/components/chat/ProjectMembersDialog", () => ({
  ProjectMembersDialog: () => null,
}));

vi.mock("@/components/quotes/RequestSummaryBadges", () => ({
  RequestSummaryBadges: () => null,
}));

vi.mock("@/components/quotes/RequestedQuantityFilter", () => ({
  RequestedQuantityFilter: () => null,
}));

vi.mock("@/components/quotes/DrawingPreviewDialog", () => ({
  DrawingPreviewDialog: () => null,
}));

vi.mock("@/components/SignInDialog", () => ({
  SignInDialog: () => null,
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    storage: {
      from: () => ({
        download: vi.fn(),
      }),
    },
  },
}));

vi.mock("recharts", () => ({
  CartesianGrid: () => null,
  Label: () => null,
  Legend: () => null,
  ResponsiveContainer: ({ children }: PropsWithChildren) => <div>{children}</div>,
  Scatter: () => null,
  ScatterChart: ({ children }: PropsWithChildren) => <div>{children}</div>,
  Tooltip: () => null,
  XAxis: () => null,
  YAxis: () => null,
  ZAxis: () => null,
}));

function makeJob(overrides: Record<string, unknown> = {}) {
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
    selected_vendor_quote_offer_id: null,
    requested_quote_quantities: [1],
    requested_by_date: null,
    tags: [],
    created_at: "2026-03-05T12:00:00.000Z",
    updated_at: "2026-03-05T12:30:00.000Z",
    ...overrides,
  };
}

function makeSummary(overrides: Record<string, unknown> = {}) {
  return {
    jobId: "job-1",
    partNumber: "1093-00001",
    revision: "A",
    description: "Part description",
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

function renderWithClient(component: React.ReactNode, initialEntry = "/") {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>{component}</MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("top-level create actions", () => {
  beforeEach(() => {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: vi.fn().mockImplementation(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });

    mockUseAppSession.mockReturnValue({
      user: { id: "user-1", email: "client@example.com" },
      activeMembership: {
        id: "membership-1",
        role: "client",
        organizationId: "org-1",
        organizationName: "Acme",
        organizationSlug: "acme",
      },
      isLoading: false,
      isVerifiedAuth: true,
      signOut: vi.fn(),
    });

    mockOpenFilePicker.mockReset();
    mockHandleFileInputChange.mockReset();
    mockUseClientJobFilePicker.mockReset();
    api.checkClientIntakeCompatibility.mockResolvedValue("available");
    api.getClientIntakeCompatibilityMessage.mockReturnValue("compatibility ok");
    mockUseClientJobFilePicker.mockImplementation(() => ({
      accept: ".step,.pdf",
      inputRef: { current: null },
      openFilePicker: mockOpenFilePicker,
      handleFileInputChange: mockHandleFileInputChange,
    }));

    api.fetchAccessibleProjects.mockResolvedValue([
      {
        project: {
          id: "project-1",
          name: "Project One",
          created_at: "2026-03-05T08:00:00.000Z",
          updated_at: "2026-03-05T10:00:00.000Z",
        },
        currentUserRole: "owner",
      },
    ]);
    api.fetchAccessibleJobs.mockResolvedValue([makeJob()]);
    api.fetchClientActivityEventsByJobIds.mockResolvedValue([]);
    api.fetchArchivedProjects.mockResolvedValue([]);
    api.fetchArchivedJobs.mockResolvedValue([]);
    api.fetchJobPartSummariesByJobIds.mockResolvedValue([makeSummary()]);
    api.fetchProjectJobMembershipsByJobIds.mockResolvedValue([]);
    api.fetchSidebarPins.mockResolvedValue({ projectIds: [], jobIds: [] });
    api.fetchJobsByProject.mockResolvedValue([makeJob()]);
    api.fetchProject.mockResolvedValue({
      id: "project-1",
      name: "Project One",
    });
    api.fetchProjectInvites.mockResolvedValue([]);
    api.fetchProjectMemberships.mockResolvedValue([]);
    api.resolveClientPartDetailRoute.mockResolvedValue({
      routeId: "job-1",
      jobId: "job-1",
      source: "job",
    });
    api.fetchPartDetailByJobId.mockResolvedValue({
      job: makeJob(),
      part: {
        id: "part-1",
        normalized_key: "job-one",
        vendorQuotes: [],
        extraction: null,
        quantity: 1,
        approvedRequirement: null,
      },
      summary: makeSummary(),
      projectIds: ["project-1"],
      files: [],
      drawingPreview: { pageCount: 0, thumbnail: null, pages: [] },
      latestQuoteRequest: null,
      latestQuoteRun: null,
      revisionSiblings: [],
    });
    api.fetchClientQuoteWorkspaceByJobIds.mockResolvedValue([
      {
        job: makeJob(),
        files: [],
        summary: makeSummary(),
        part: {
          id: "part-1",
          job_id: "job-1",
          normalized_key: "job-one",
          quantity: 1,
          cad_file_id: null,
          drawing_file_id: null,
          created_at: "2026-03-05T12:00:00.000Z",
          updated_at: "2026-03-05T12:00:00.000Z",
          organization_id: "org-1",
          name: "Part 1",
          cadFile: null,
          drawingFile: null,
          extraction: null,
          approvedRequirement: null,
          vendorQuotes: [],
        },
        projectIds: ["project-1"],
        drawingPreview: { pageCount: 0, thumbnail: null, pages: [] },
        latestQuoteRequest: null,
        latestQuoteRun: null,
      },
    ]);
    api.isProjectCollaborationSchemaUnavailable.mockReturnValue(false);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("uses the file picker for ClientHome new project", async () => {
    renderWithClient(<ClientHome />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "New Project" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "New Job" }));
    fireEvent.click(screen.getByRole("button", { name: "New Project" }));

    expect(mockOpenFilePicker).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("Create project")).not.toBeInTheDocument();
  });

  it("does not toast when the startup compatibility probe reports a legacy schema", async () => {
    api.checkClientIntakeCompatibility.mockResolvedValueOnce("legacy");

    renderWithClient(<ClientHome />);

    await waitFor(() => {
      expect(api.checkClientIntakeCompatibility).toHaveBeenCalledTimes(1);
    });

    expect(toastMock.error).not.toHaveBeenCalled();
  });

  it("does not toast when the startup compatibility probe fails transiently", async () => {
    api.checkClientIntakeCompatibility.mockRejectedValueOnce(new Error("temporary connectivity issue"));

    renderWithClient(<ClientHome />);

    await waitFor(() => {
      expect(api.checkClientIntakeCompatibility).toHaveBeenCalledTimes(1);
    });

    expect(toastMock.error).not.toHaveBeenCalled();
  });

  it("uses the file picker for ClientProject new project", async () => {
    renderWithClient(
      <Routes>
        <Route path="/projects/:projectId" element={<ClientProject />} />
      </Routes>,
      "/projects/project-1",
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "New Project" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "New Job" }));
    fireEvent.click(screen.getByRole("button", { name: "New Project" }));

    expect(mockOpenFilePicker).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("Create project")).not.toBeInTheDocument();
  });

  it("uses the file picker for ClientPart new project", async () => {
    mockUseClientJobFilePicker
      .mockImplementationOnce(() => ({
        accept: ".step,.pdf",
        inputRef: { current: null },
        openFilePicker: mockOpenFilePicker,
        handleFileInputChange: mockHandleFileInputChange,
      }))
      .mockImplementationOnce(() => ({
        accept: ".step,.pdf",
        inputRef: { current: null },
        openFilePicker: vi.fn(),
        handleFileInputChange: vi.fn(),
      }));

    renderWithClient(
      <Routes>
        <Route path="/parts/:jobId" element={<ClientPart />} />
      </Routes>,
      "/parts/job-1",
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "New Project" })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "New Job" }));
    fireEvent.click(screen.getByRole("button", { name: "New Project" }));

    expect(mockOpenFilePicker).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("Create project")).not.toBeInTheDocument();
  });


  it("shows part header options with shared actions and renames the part", async () => {
    api.updateClientPartRequest.mockResolvedValue("job-1");

    renderWithClient(
      <Routes>
        <Route path="/parts/:jobId" element={<ClientPart />} />
      </Routes>,
      "/parts/job-1",
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /part options/i })).toBeInTheDocument();
    });

    expect(screen.getByRole("button", { name: /part options/i })).toBeInTheDocument();

    expect(await screen.findByText("Edit part")).toBeInTheDocument();
    expect(screen.getByText("Rename part")).toBeInTheDocument();
    expect(screen.getByText("Add to project")).toBeInTheDocument();
    expect(screen.getByText("Remove from project")).toBeInTheDocument();
    expect(screen.getByText("Archive part")).toBeInTheDocument();
    expect(screen.getByText("Pin")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Rename part"));

    const input = await screen.findByRole("textbox", { name: "Rename part" });
    fireEvent.change(input, { target: { value: "RENAMED-123" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(api.updateClientPartRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          jobId: "job-1",
          partNumber: "RENAMED-123",
        }),
      );
    });
  });

  it("creates a new project from the part header actions when no other project targets exist", async () => {
    api.createProject.mockResolvedValue("project-2");
    api.assignJobToProject.mockResolvedValue("job-1");
    api.fetchAccessibleProjects.mockResolvedValue([]);
    api.fetchAccessibleJobs.mockResolvedValue([makeJob({ project_id: null })]);
    api.fetchPartDetailByJobId.mockResolvedValue({
      job: makeJob({ project_id: null }),
      part: {
        id: "part-1",
        normalized_key: "job-one",
        vendorQuotes: [],
        extraction: null,
        quantity: 1,
        approvedRequirement: null,
      },
      summary: makeSummary(),
      projectIds: [],
      files: [],
      drawingPreview: { pageCount: 0, thumbnail: null, pages: [] },
      latestQuoteRequest: null,
      latestQuoteRun: null,
      revisionSiblings: [],
    });

    renderWithClient(
      <Routes>
        <Route path="/parts/:jobId" element={<ClientPart />} />
        <Route path="/projects/:projectId" element={<div>Project view</div>} />
      </Routes>,
      "/parts/job-1",
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /create new project/i })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /create new project/i }));

    await waitFor(() => {
      expect(api.createProject).toHaveBeenCalledWith({ name: "1093-00001 rev A" });
    });
    expect(api.assignJobToProject).toHaveBeenCalledWith({ jobId: "job-1", projectId: "project-2" });
    expect(await screen.findByText("Project view")).toBeInTheDocument();
  });

  it("archives the current part from the header options menu", async () => {
    api.archiveJob.mockResolvedValue("job-1");

    renderWithClient(
      <Routes>
        <Route path="/parts/:jobId" element={<ClientPart />} />
        <Route path="/" element={<div>Home</div>} />
      </Routes>,
      "/parts/job-1",
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /part options/i })).toBeInTheDocument();
    });

    expect(screen.getByRole("button", { name: /part options/i })).toBeInTheDocument();
    fireEvent.click(await screen.findByText("Archive part"));

    await waitFor(() => {
      expect(api.archiveJob).toHaveBeenCalledWith("job-1");
    });
  });

  it("undoes archived sidebar projects with Ctrl+Z", async () => {
    api.archiveProject.mockResolvedValue("project-1");
    api.unarchiveProject.mockResolvedValue("project-1");

    renderWithClient(<ClientHome />);

    fireEvent.click(screen.getByRole("button", { name: "Archive Sidebar Project" }));

    await waitFor(() => {
      expect(api.archiveProject).toHaveBeenCalledWith("project-1");
    });

    fireEvent.keyDown(window, { key: "z", ctrlKey: true });

    await waitFor(() => {
      expect(api.unarchiveProject).toHaveBeenCalledWith("project-1");
    });
  });

  it("undoes archived sidebar parts with Ctrl+Z", async () => {
    api.archiveJob.mockResolvedValue("job-1");
    api.unarchiveJob.mockResolvedValue("job-1");

    renderWithClient(<ClientHome />);

    fireEvent.click(screen.getByRole("button", { name: "Archive Sidebar Part" }));

    await waitFor(() => {
      expect(api.archiveJob).toHaveBeenCalledWith("job-1");
    });

    fireEvent.keyDown(window, { key: "z", ctrlKey: true });

    await waitFor(() => {
      expect(api.unarchiveJob).toHaveBeenCalledWith("job-1");
    });
  });
});
