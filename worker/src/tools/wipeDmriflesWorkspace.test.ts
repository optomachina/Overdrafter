// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import {
  buildDryRunReport,
  executeWorkspaceHardDelete,
  groupStoragePaths,
  resolveWorkspaceTarget,
  runWorkspaceWipe,
  type StorageTarget,
  type WorkspaceSnapshot,
  type WorkspaceTarget,
} from "./wipeDmriflesWorkspace";

type MockRow = Record<string, unknown>;

function createSnapshot(overrides: Partial<WorkspaceSnapshot> = {}): WorkspaceSnapshot {
  return {
    jobs: [{ id: "job-1" }, { id: "job-2" }],
    jobFiles: [{ id: "file-1", bucket: "job-files", path: "jobs/job-1/file.step" }],
    organizationFileBlobs: [{ id: "blob-1", bucket: "job-files", path: "org/blob.step" }],
    parts: [{ id: "part-1" }],
    drawingPreviewAssets: [{ id: "preview-1", bucket: "job-files", path: "previews/part-1.png" }],
    drawingExtractions: [{ id: "extract-1", part_id: "part-1" }],
    approvedPartRequirements: [{ id: "requirement-1", part_id: "part-1" }],
    quoteRuns: [{ id: "run-1", job_id: "job-1" }],
    vendorQuoteResults: [{ id: "result-1", part_id: "part-1" }],
    vendorQuoteOffers: [{ id: "offer-1" }],
    vendorQuoteArtifacts: [{ id: "artifact-1", bucket: "quote-artifacts", path: "quotes/result-1.pdf" }],
    publishedQuotePackages: [{ id: "package-1", job_id: "job-1" }],
    publishedQuoteOptions: [{ id: "option-1" }],
    clientSelections: [{ id: "selection-1" }],
    workQueue: [{ id: "queue-1" }],
    auditEvents: [{ id: "audit-1" }],
    pricingPolicies: [{ id: "policy-1" }],
    projects: [{ id: "project-1" }],
    projectJobs: [{ id: "project-job-1", project_id: "project-1" }],
    projectMemberships: [{ id: "project-membership-1", project_id: "project-1" }],
    projectInvites: [{ id: "project-invite-1", project_id: "project-1" }],
    userPinnedProjects: [{ id: "pin-project-1", project_id: "project-1", user_id: "user-1" }],
    userPinnedJobs: [{ id: "pin-job-1", job_id: "job-1", user_id: "user-1" }],
    ...overrides,
  };
}

function createSupabaseMock({
  users = [],
  tables = {},
}: {
  users?: Array<{ id: string; email?: string | null }>;
  tables?: Record<string, MockRow[]>;
} = {}) {
  const state = new Map<string, MockRow[]>(Object.entries(tables).map(([table, rows]) => [table, [...rows]]));
  const operations: string[] = [];

  const filterRows = (rows: MockRow[], column: string, value: unknown) =>
    rows.filter((row) => row[column] === value);

  const filterRowsIn = (rows: MockRow[], column: string, values: unknown[]) =>
    rows.filter((row) => values.includes(row[column]));

  const supabase = {
    auth: {
      admin: {
        listUsers: vi.fn(async () => {
          operations.push("auth.listUsers");
          return { data: { users }, error: null };
        }),
        deleteUser: vi.fn(async (userId: string) => {
          operations.push(`auth.deleteUser:${userId}`);
          return { data: null, error: null };
        }),
      },
    },
    storage: {
      from: vi.fn((bucket: string) => ({
        remove: vi.fn(async (paths: string[]) => {
          operations.push(`storage.remove:${bucket}:${paths.join(",")}`);
          return { data: null, error: null };
        }),
      })),
    },
    from: vi.fn((table: string) => ({
      select: vi.fn((_columns: string) => ({
        eq: vi.fn(async (column: string, value: unknown) => {
          operations.push(`select:${table}:${column}=${String(value)}`);
          return { data: filterRows(state.get(table) ?? [], column, value), error: null };
        }),
        in: vi.fn(async (column: string, values: unknown[]) => {
          operations.push(`select:${table}:${column} in [${values.join(",")}]`);
          return { data: filterRowsIn(state.get(table) ?? [], column, values), error: null };
        }),
      })),
      delete: vi.fn(() => ({
        eq: vi.fn(async (column: string, value: unknown) => {
          operations.push(`delete:${table}:${column}=${String(value)}`);
          state.set(
            table,
            (state.get(table) ?? []).filter((row) => row[column] !== value),
          );
          return { data: null, error: null };
        }),
        in: vi.fn(async (column: string, values: unknown[]) => {
          operations.push(`delete:${table}:${column} in [${values.join(",")}]`);
          state.set(
            table,
            (state.get(table) ?? []).filter((row) => !values.includes(row[column])),
          );
          return { data: null, error: null };
        }),
      })),
    })),
  };

  return { supabase, operations };
}

describe("wipeDmriflesWorkspace", () => {
  const target: WorkspaceTarget = {
    email: "dmrifles@gmail.com",
    userId: "user-1",
    membershipId: "membership-1",
    organizationId: "org-1",
  };

  it("resolves the target workspace from the auth user and single client membership", async () => {
    const { supabase } = createSupabaseMock({
      users: [{ id: "user-1", email: "dmrifles@gmail.com" }],
      tables: {
        organization_memberships: [{ id: "membership-1", organization_id: "org-1", role: "client", user_id: "user-1" }],
      },
    });

    await expect(resolveWorkspaceTarget(supabase as never, "dmrifles@gmail.com")).resolves.toEqual(target);
  });

  it("fails when the auth user is missing", async () => {
    const { supabase } = createSupabaseMock();

    await expect(resolveWorkspaceTarget(supabase as never, "dmrifles@gmail.com")).rejects.toThrow(
      "Expected exactly one auth user for dmrifles@gmail.com, found 0.",
    );
  });

  it("fails when multiple memberships exist for the user", async () => {
    const { supabase } = createSupabaseMock({
      users: [{ id: "user-1", email: "dmrifles@gmail.com" }],
      tables: {
        organization_memberships: [
          { id: "membership-1", organization_id: "org-1", role: "client", user_id: "user-1" },
          { id: "membership-2", organization_id: "org-2", role: "internal_admin", user_id: "user-1" },
        ],
      },
    });

    await expect(resolveWorkspaceTarget(supabase as never, "dmrifles@gmail.com")).rejects.toThrow(
      "Expected dmrifles@gmail.com to have exactly one total membership, found 2.",
    );
  });

  it("builds the dry-run summary with counts and samples", () => {
    const report = buildDryRunReport(target, createSnapshot());

    expect(report.mode).toBe("dry_run");
    expect(report.counts.jobs).toBe(2);
    expect(report.counts.projects).toBe(1);
    expect(report.counts.storageObjects).toBe(4);
    expect(report.samples.jobs).toEqual(["job-1", "job-2"]);
    expect(report.storageBuckets).toEqual({
      "job-files": 3,
      "quote-artifacts": 1,
    });
  });

  it("groups storage paths by bucket and deduplicates them", () => {
    const grouped = groupStoragePaths([
      { id: "a", bucket: "job-files", path: "same.step" },
      { id: "b", bucket: "job-files", path: "same.step" },
      { id: "c", bucket: "quote-artifacts", path: "quote.pdf" },
    ] satisfies StorageTarget[]);

    expect(grouped).toEqual(
      new Map([
        ["job-files", ["same.step"]],
        ["quote-artifacts", ["quote.pdf"]],
      ]),
    );
  });

  it("does not perform deletes during dry run", async () => {
    const { supabase, operations } = createSupabaseMock({
      users: [{ id: "user-1", email: "dmrifles@gmail.com" }],
      tables: {
        organization_memberships: [{ id: "membership-1", organization_id: "org-1", role: "client", user_id: "user-1" }],
        jobs: [{ id: "job-1", organization_id: "org-1" }],
        job_files: [{ id: "file-1", organization_id: "org-1", storage_bucket: "job-files", storage_path: "jobs/job-1/file.step" }],
        organization_file_blobs: [],
        parts: [],
        drawing_preview_assets: [],
        drawing_extractions: [],
        approved_part_requirements: [],
        quote_runs: [],
        vendor_quote_results: [],
        vendor_quote_offers: [],
        vendor_quote_artifacts: [],
        published_quote_packages: [],
        published_quote_options: [],
        client_selections: [],
        work_queue: [],
        audit_events: [],
        pricing_policies: [],
        projects: [],
      },
    });

    await runWorkspaceWipe(supabase as never, { apply: false, email: "dmrifles@gmail.com" }, () => {});

    expect(operations.some((operation) => operation.startsWith("delete:"))).toBe(false);
    expect(operations.some((operation) => operation.startsWith("storage.remove:"))).toBe(false);
    expect(operations.some((operation) => operation.startsWith("auth.deleteUser:"))).toBe(false);
  });

  it("deletes data in dependency order and removes the auth user last", async () => {
    const { supabase, operations } = createSupabaseMock();

    await executeWorkspaceHardDelete(supabase as never, target, createSnapshot(), () => {});

    expect(operations).toEqual([
      "storage.remove:job-files:jobs/job-1/file.step,org/blob.step,previews/part-1.png",
      "storage.remove:quote-artifacts:quotes/result-1.pdf",
      "delete:client_selections:organization_id=org-1",
      "delete:published_quote_options:organization_id=org-1",
      "delete:vendor_quote_artifacts:organization_id=org-1",
      "delete:vendor_quote_offers:organization_id=org-1",
      "delete:vendor_quote_results:organization_id=org-1",
      "delete:drawing_preview_assets:organization_id=org-1",
      "delete:drawing_extractions:organization_id=org-1",
      "delete:approved_part_requirements:organization_id=org-1",
      "delete:work_queue:organization_id=org-1",
      "delete:audit_events:organization_id=org-1",
      "delete:published_quote_packages:organization_id=org-1",
      "delete:quote_runs:organization_id=org-1",
      "delete:parts:organization_id=org-1",
      "delete:job_files:organization_id=org-1",
      "delete:organization_file_blobs:organization_id=org-1",
      "delete:user_pinned_projects:project_id in [project-1]",
      "delete:user_pinned_jobs:job_id in [job-1]",
      "delete:project_invites:project_id in [project-1]",
      "delete:project_memberships:project_id in [project-1]",
      "delete:project_jobs:project_id in [project-1]",
      "delete:projects:organization_id=org-1",
      "delete:jobs:organization_id=org-1",
      "delete:pricing_policies:organization_id=org-1",
      "delete:organization_memberships:id=membership-1",
      "auth.deleteUser:user-1",
    ]);
  });
});
