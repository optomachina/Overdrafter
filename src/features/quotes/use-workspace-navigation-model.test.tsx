import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { JobRecord } from "@/features/quotes/types";
import { useClientWorkspaceData } from "@/features/quotes/use-client-workspace-data";
import {
  deriveWorkspaceNavigationCandidate,
  useWorkspaceNavigationModel,
  type WorkspaceNavigationModel,
} from "@/features/quotes/use-workspace-navigation-model";
import { createWorkspaceAccessScope } from "@/features/quotes/workspace-navigation";

const {
  fetchAccessibleJobs,
  fetchAccessibleProjects,
  fetchArchivedJobs,
  fetchArchivedProjects,
  fetchJobPartSummariesByJobIds,
  fetchProjectJobMembershipsByJobIds,
  fetchSidebarPins,
} = vi.hoisted(() => ({
  fetchAccessibleJobs: vi.fn(),
  fetchAccessibleProjects: vi.fn(),
  fetchArchivedJobs: vi.fn(),
  fetchArchivedProjects: vi.fn(),
  fetchJobPartSummariesByJobIds: vi.fn(),
  fetchProjectJobMembershipsByJobIds: vi.fn(),
  fetchSidebarPins: vi.fn(),
}));

vi.mock("@/features/quotes/api/workspace-access", () => ({
  fetchAccessibleJobs,
  fetchAccessibleProjects,
  fetchArchivedJobs,
  fetchArchivedProjects,
  fetchJobPartSummariesByJobIds,
  fetchProjectJobMembershipsByJobIds,
  fetchSidebarPins,
}));

function makeJob(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "job-1",
    organization_id: "org-1",
    project_id: null,
    selected_vendor_quote_offer_id: null,
    created_by: "user-1",
    title: "Bracket",
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

function makeAccessibleProject(id: string, organizationId: string, name: string) {
  return {
    project: {
      id,
      organization_id: organizationId,
      name,
      created_at: "2026-03-01T00:00:00.000Z",
      updated_at: "2026-03-05T00:00:00.000Z",
    },
    partCount: 1,
    inviteCount: 0,
    currentUserRole: "owner",
  };
}

const projects = [makeAccessibleProject("project-1", "org-1", "Project One")];

const USER_ONE_SCOPE = createWorkspaceAccessScope({ userId: "user-1", organizationId: "org-1", role: "client" });

function deferredPromise<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });

  return { promise, resolve };
}

describe("deriveWorkspaceNavigationCandidate", () => {
  it("includes grouped and ungrouped parts in the global parts list", () => {
    const grouped = makeJob({ id: "job-1", project_id: "project-1" });
    const ungrouped = makeJob({ id: "job-2", project_id: null, title: "Plate" });
    const candidate = deriveWorkspaceNavigationCandidate({
      accessibleJobs: [grouped, ungrouped],
      accessibleProjects: projects,
      projectJobMemberships: [{ job_id: "job-1", project_id: "project-1" }],
      jobsFetching: false,
      jobsSuccess: true,
      projectsFetching: false,
      projectsSuccess: true,
      membershipsFetching: false,
      membershipsSuccess: true,
      projectCollaborationUnavailable: false,
    });

    expect(candidate.isCoherent).toBe(true);
    expect(candidate.parts.map((job) => job.id)).toEqual(["job-1", "job-2"]);
    expect(candidate.jobsByProjectId.get("project-1")?.map((job) => job.id)).toEqual(["job-1"]);
    expect(candidate.partToProjectIds.get("job-1")).toEqual(["project-1"]);
    expect(candidate.partToProjectIds.get("job-2")).toEqual([]);
  });

  it("marks candidate incoherent while membership query lags a new job set", () => {
    const candidate = deriveWorkspaceNavigationCandidate({
      accessibleJobs: [makeJob({ id: "job-1" }), makeJob({ id: "job-2" })],
      accessibleProjects: projects,
      projectJobMemberships: [],
      jobsFetching: false,
      jobsSuccess: true,
      projectsFetching: false,
      projectsSuccess: true,
      membershipsFetching: true,
      membershipsSuccess: false,
      projectCollaborationUnavailable: false,
    });

    expect(candidate.isCoherent).toBe(false);
    expect(candidate.coherenceState).toBe("memberships_pending");
  });
});

describe("useWorkspaceNavigationModel", () => {
  it("keeps the last coherent model while the next candidate is incoherent", () => {
    const initialJobs = [makeJob({ id: "job-1", project_id: "project-1" })];
    const nextJobs = [
      makeJob({ id: "job-1", project_id: "project-1" }),
      makeJob({ id: "job-2", project_id: "project-1", title: "Plate" }),
    ];

    const { result, rerender } = renderHook(
      ({
        accessibleJobs,
        projectJobMemberships,
        membershipsFetching,
        membershipsSuccess,
      }: {
        accessibleJobs: JobRecord[];
        projectJobMemberships: Array<{ job_id: string; project_id: string }>;
        membershipsFetching: boolean;
        membershipsSuccess: boolean;
      }) =>
        useWorkspaceNavigationModel({
          accessScope: USER_ONE_SCOPE,
          accessibleJobs,
          accessibleProjects: projects,
          projectJobMemberships,
          summariesByJobId: new Map(),
          accessibleJobsQuery: { isFetching: false, isSuccess: true },
          accessibleProjectsQuery: { isFetching: false, isSuccess: true },
          projectJobMembershipsQuery: { isFetching: membershipsFetching, isSuccess: membershipsSuccess },
          projectCollaborationUnavailable: false,
        }),
      {
        initialProps: {
          accessibleJobs: initialJobs,
          projectJobMemberships: [{ job_id: "job-1", project_id: "project-1" }],
          membershipsFetching: false,
          membershipsSuccess: true,
        },
      },
    );

    expect(result.current.isCoherent).toBe(true);
    expect(result.current.parts.map((job) => job.id)).toEqual(["job-1"]);
    const stableVersion = result.current.version;

    act(() => {
      rerender({
        accessibleJobs: nextJobs,
        projectJobMemberships: [],
        membershipsFetching: true,
        membershipsSuccess: false,
      });
    });

    expect(result.current.isCoherent).toBe(true);
    expect(result.current.parts.map((job) => job.id)).toEqual(["job-1"]);
    expect(result.current.version).toBe(stableVersion);

    act(() => {
      rerender({
        accessibleJobs: nextJobs,
        projectJobMemberships: [
          { job_id: "job-1", project_id: "project-1" },
          { job_id: "job-2", project_id: "project-1" },
        ],
        membershipsFetching: false,
        membershipsSuccess: true,
      });
    });

    expect(result.current.isCoherent).toBe(true);
    expect(result.current.parts.map((job) => job.id)).toEqual(["job-1", "job-2"]);
    expect(result.current.version).toBeGreaterThan(stableVersion);
  });
});

describe("useWorkspaceNavigationModel across sessions and access scopes", () => {
  type Session = { userId: string | null; organizationId: string | null; role: string | null };

  const CLIENT_A: Session = { userId: "user-a", organizationId: "org-a", role: "client" };
  const OUTSIDER_B_SIGNING_IN: Session = { userId: "user-b", organizationId: null, role: null };
  const OUTSIDER_B: Session = { userId: "user-b", organizationId: "org-b", role: "client" };
  const SIGNED_OUT: Session = { userId: null, organizationId: null, role: null };

  const A_JOBS = [
    makeJob({ id: "job-a1", organization_id: "org-a", created_by: "user-a", project_id: "project-a", title: "FX-100 bracket" }),
    makeJob({ id: "job-a2", organization_id: "org-a", created_by: "user-a", title: "FX-101 plate" }),
  ];
  const A_PROJECTS = [makeAccessibleProject("project-a", "org-a", "Client A project")];
  const A_MEMBERSHIPS = [{ job_id: "job-a1", project_id: "project-a" }];
  const A_LABELS = ["FX-100 bracket", "FX-101 plate", "Client A project"];
  const A_IDS = ["job-a1", "job-a2", "project-a"];
  const B_JOBS = [makeJob({ id: "job-b1", organization_id: "org-b", created_by: "user-b", title: "OUT-500 housing" })];

  type RenderRecord = { userId: string | null; labels: string[] };

  /** Renders the workspace list the way ClientParts does: scoped workspace queries feed the navigation model. */
  function WorkspaceListHarness({ session, renders }: Readonly<{ session: Session; renders: RenderRecord[] }>) {
    const accessScope = createWorkspaceAccessScope(session);
    const data = useClientWorkspaceData({
      enabled: Boolean(session.userId),
      accessScope,
      projectCollaborationUnavailable: false,
    });
    const navigationModel = useWorkspaceNavigationModel({
      accessScope,
      accessibleJobs: data.accessibleJobs,
      accessibleProjects: data.accessibleProjects,
      projectJobMemberships: data.projectJobMemberships,
      summariesByJobId: data.summariesByJobId,
      accessibleJobsQuery: data.accessibleJobsQuery,
      accessibleProjectsQuery: data.accessibleProjectsQuery,
      projectJobMembershipsQuery: data.projectJobMembershipsQuery,
      projectCollaborationUnavailable: false,
    });
    const labels = [
      ...navigationModel.parts.map((job) => job.title),
      ...navigationModel.sidebarProjects.map((project) => project.name),
    ];

    // Every render is recorded, not only the final DOM, so a single frame of the
    // previous account's rows fails the test.
    renders.push({ userId: session.userId, labels });

    return (
      <ul aria-label="Workspace parts">
        {labels.map((label) => (
          <li key={label}>{label}</li>
        ))}
      </ul>
    );
  }

  /** Renders that showed any of client A's rows, with the session that saw them. */
  function leakedRenders(renders: RenderRecord[]): RenderRecord[] {
    return renders
      .map((record) => ({ userId: record.userId, labels: record.labels.filter((label) => A_LABELS.includes(label)) }))
      .filter((record) => record.labels.length > 0);
  }

  function modelIds(model: WorkspaceNavigationModel): string[] {
    return [
      ...model.parts.map((job) => job.id),
      ...model.coherentJobIds,
      ...model.sidebarProjects.map((project) => project.id),
      ...model.partToProjectIds.keys(),
      ...[...model.partToProjectIds.values()].flat(),
      ...model.jobsByProjectId.keys(),
      ...[...model.jobsByProjectId.values()].flat().map((job) => job.id),
    ];
  }

  it("never renders the previous account's parts after an in-tab sign-out and sign-in while the next account's queries are pending", async () => {
    let serverAccount: "a" | "b" = "a";
    const outsiderJobs = deferredPromise<JobRecord[]>();
    const outsiderProjects = deferredPromise<ReturnType<typeof makeAccessibleProject>[]>();
    const outsiderRequests: string[] = [];

    fetchAccessibleJobs.mockImplementation(() => {
      if (serverAccount === "a") {
        return Promise.resolve(A_JOBS);
      }

      outsiderRequests.push("jobs");
      return outsiderJobs.promise;
    });
    fetchAccessibleProjects.mockImplementation(() => {
      if (serverAccount === "a") {
        return Promise.resolve(A_PROJECTS);
      }

      outsiderRequests.push("projects");
      return outsiderProjects.promise;
    });
    fetchProjectJobMembershipsByJobIds.mockImplementation(() =>
      Promise.resolve(serverAccount === "a" ? A_MEMBERSHIPS : []),
    );
    fetchJobPartSummariesByJobIds.mockResolvedValue([]);
    fetchSidebarPins.mockResolvedValue({ projectIds: [], jobIds: [] });
    fetchArchivedJobs.mockResolvedValue([]);
    fetchArchivedProjects.mockResolvedValue([]);

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const renders: RenderRecord[] = [];
    const view = (session: Session) => (
      <QueryClientProvider client={queryClient}>
        <WorkspaceListHarness session={session} renders={renders} />
      </QueryClientProvider>
    );
    const { rerender } = render(view(CLIENT_A));

    // Positive control: client A's own rows render through the same path.
    expect(await screen.findByText("FX-100 bracket")).toBeInTheDocument();
    expect(await screen.findByText("Client A project")).toBeInTheDocument();
    expect(leakedRenders(renders).length).toBeGreaterThan(0);

    const switchStart = renders.length;

    // Sign-out, as useAppSession does it: purge subject-bound queries, then render
    // with no user.
    act(() => {
      void queryClient.cancelQueries();
      queryClient.removeQueries();
      rerender(view(SIGNED_OUT));
    });

    // Sign-in as B: the session first resolves without a membership, then with B's
    // organization, while B's workspace reads are still in flight.
    serverAccount = "b";
    act(() => {
      rerender(view(OUTSIDER_B_SIGNING_IN));
    });
    act(() => {
      rerender(view(OUTSIDER_B));
    });
    await waitFor(() => expect(outsiderRequests).toEqual(expect.arrayContaining(["jobs", "projects"])));

    const sinceSignOut = renders.slice(switchStart);
    expect(sinceSignOut.map((record) => record.userId)).toEqual(
      expect.arrayContaining([SIGNED_OUT.userId, OUTSIDER_B.userId]),
    );
    expect(sinceSignOut.every((record) => record.userId !== CLIENT_A.userId)).toBe(true);
    expect(leakedRenders(sinceSignOut)).toEqual([]);
    for (const label of A_LABELS) {
      expect(screen.queryByText(label)).not.toBeInTheDocument();
    }

    await act(async () => {
      outsiderJobs.resolve(B_JOBS);
      outsiderProjects.resolve([]);
    });

    expect(await screen.findByText("OUT-500 housing")).toBeInTheDocument();
    expect(leakedRenders(renders.slice(switchStart))).toEqual([]);
  });

  it.each([
    ["another user's session", OUTSIDER_B],
    ["the same user's other organization", { userId: "user-a", organizationId: "org-c", role: "client" }],
    ["a role change in the same organization", { userId: "user-a", organizationId: "org-a", role: "admin" }],
    ["signing out", SIGNED_OUT],
  ] satisfies Array<[string, Session]>)(
    "drops the cached model on the first render after switching to %s",
    (_label, nextSession) => {
      type Props = {
        session: Session;
        accessibleJobs: JobRecord[];
        accessibleProjects: ReturnType<typeof makeAccessibleProject>[];
        projectJobMemberships: Array<{ job_id: string; project_id: string }>;
        pending: boolean;
      };
      const models: WorkspaceNavigationModel[] = [];
      const { result, rerender } = renderHook(
        ({ session, accessibleJobs, accessibleProjects, projectJobMemberships, pending }: Props) => {
          const model = useWorkspaceNavigationModel({
            accessScope: createWorkspaceAccessScope(session),
            accessibleJobs,
            accessibleProjects,
            projectJobMemberships,
            summariesByJobId: new Map(),
            accessibleJobsQuery: { isFetching: pending, isSuccess: !pending },
            accessibleProjectsQuery: { isFetching: pending, isSuccess: !pending },
            projectJobMembershipsQuery: { isFetching: pending, isSuccess: !pending },
            projectCollaborationUnavailable: false,
          });
          models.push(model);
          return model;
        },
        {
          initialProps: {
            session: CLIENT_A,
            accessibleJobs: A_JOBS,
            accessibleProjects: A_PROJECTS,
            projectJobMemberships: A_MEMBERSHIPS,
            pending: false,
          },
        },
      );

      expect(result.current.isCoherent).toBe(true);
      expect(result.current.version).toBeGreaterThan(0);
      expect(modelIds(result.current)).toEqual(expect.arrayContaining(A_IDS));

      const switchStart = models.length;

      // The next scope's reads are pending, so its candidate is incoherent and
      // carries no rows of its own. The second render stands in for the re-renders
      // that fetch status changes cause while those reads are in flight.
      for (let render = 0; render < 2; render += 1) {
        act(() => {
          rerender({
            session: nextSession,
            accessibleJobs: [],
            accessibleProjects: [],
            projectJobMemberships: [],
            pending: true,
          });
        });
      }

      expect(models.length - switchStart).toBeGreaterThanOrEqual(2);
      for (const model of models.slice(switchStart)) {
        expect(modelIds(model)).toEqual([]);
        expect(model.isCoherent).toBe(false);
        expect(model.uiFlags).toEqual({ showProjectsEmpty: false, showPartsEmpty: false });
      }

      if (!nextSession.userId) {
        return;
      }

      act(() => {
        rerender({
          session: nextSession,
          accessibleJobs: B_JOBS,
          accessibleProjects: [],
          projectJobMemberships: [],
          pending: false,
        });
      });

      expect(result.current.isCoherent).toBe(true);
      expect(result.current.parts.map((job) => job.id)).toEqual(["job-b1"]);
      for (const model of models.slice(switchStart)) {
        expect(modelIds(model).filter((id) => A_IDS.includes(id))).toEqual([]);
      }
    },
  );

  it.each([
    ["the next scope's reads are already cached", OUTSIDER_B, B_JOBS],
    // Identical inputs keep the derived candidate identical across the switch.
    [
      "a role change leaves the visible rows unchanged",
      { userId: "user-a", organizationId: "org-a", role: "admin" },
      A_JOBS,
    ],
  ] satisfies Array<[string, Session, JobRecord[]]>)(
    "renders one empty frame for the new scope, then its model, when %s",
    (_label, nextSession, nextJobs) => {
      const noProjects: ReturnType<typeof makeAccessibleProject>[] = [];
      const noMemberships: Array<{ job_id: string; project_id: string }> = [];
      const summaries = new Map();
      const settled = { isFetching: false, isSuccess: true };
      const models: WorkspaceNavigationModel[] = [];
      const { result, rerender } = renderHook(
        ({ session, accessibleJobs }: { session: Session; accessibleJobs: JobRecord[] }) => {
          const model = useWorkspaceNavigationModel({
            accessScope: createWorkspaceAccessScope(session),
            accessibleJobs,
            accessibleProjects: noProjects,
            projectJobMemberships: noMemberships,
            summariesByJobId: summaries,
            accessibleJobsQuery: settled,
            accessibleProjectsQuery: settled,
            projectJobMembershipsQuery: settled,
            projectCollaborationUnavailable: false,
          });
          models.push(model);
          return model;
        },
        { initialProps: { session: CLIENT_A, accessibleJobs: A_JOBS } },
      );

      expect(result.current.parts.map((job) => job.id)).toEqual(["job-a1", "job-a2"]);
      const switchStart = models.length;

      act(() => {
        rerender({ session: nextSession, accessibleJobs: nextJobs });
      });

      // The switch render itself shows nothing, whatever its inputs hold...
      const switchFrame = models[switchStart];
      expect(modelIds(switchFrame)).toEqual([]);
      expect(switchFrame.isCoherent).toBe(false);

      // ...and the model then settles on the new scope's rows instead of staying empty.
      expect(result.current.isCoherent).toBe(true);
      expect(result.current.parts.map((job) => job.id)).toEqual(nextJobs.map((job) => job.id));
      expect(result.current.version).toBeGreaterThan(0);
    },
  );
});
