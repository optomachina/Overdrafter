import "@testing-library/jest-dom/vitest";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { JobRecord } from "@/features/quotes/types";
import {
  deriveWorkspaceNavigationCandidate,
  useWorkspaceNavigationModel,
} from "@/features/quotes/use-workspace-navigation-model";

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

const projects = [
  {
    project: {
      id: "project-1",
      organization_id: "org-1",
      name: "Project One",
      created_at: "2026-03-01T00:00:00.000Z",
      updated_at: "2026-03-05T00:00:00.000Z",
    },
    partCount: 2,
    inviteCount: 0,
    currentUserRole: "owner",
  },
];

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
