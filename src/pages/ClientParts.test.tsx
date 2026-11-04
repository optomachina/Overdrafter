import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ClientParts from "./ClientParts";

const useClientHomeControllerMock = vi.fn();
const prefetchPartMock = vi.fn();
const prefetchProjectMock = vi.fn();

vi.mock("@/features/quotes/use-client-home-controller", () => ({
  useClientHomeController: (...args: unknown[]) => useClientHomeControllerMock(...args),
}));

vi.mock("@/features/notifications/use-client-workspace-notifications", () => ({
  useClientWorkspaceNotifications: () => null,
}));

vi.mock("@/features/quotes/use-quote-intelligence-workspace", () => ({
  useQuoteIntelligenceWorkspace: () => ({
    factsByJobId: new Map(),
    metadataByJobId: new Map(),
    workspaceQuery: { data: [], isLoading: false },
  }),
}));

type Row = { kind: "part" | "project_group"; id: string; title: string; href: string };

const ROWS: Row[] = [
  ...Array.from({ length: 3 }, (_, index) => ({
    kind: "project_group" as const,
    id: `project-${index + 1}`,
    title: `Project ${index + 1}`,
    href: `/projects/project-${index + 1}`,
  })),
  ...Array.from({ length: 10 }, (_, index) => ({
    kind: "part" as const,
    id: `job-${index + 1}`,
    title: `Part ${index + 1}`,
    href: `/parts/job-${index + 1}`,
  })),
];

vi.mock("@/features/quotes/quote-intelligence-view-model", () => ({
  buildPartCollection: () =>
    ROWS.map((row) => ({
      ...row,
      description: "",
      statusLabel: row.kind === "part" ? "Uploaded" : "Project group",
      reference: null,
      revision: null,
      quantity: null,
      partCount: row.kind === "part" ? null : 2,
      material: null,
      finish: null,
      process: null,
      projectNames: [],
      matchExplanations: [],
      updatedAt: null,
    })),
  filterPartCollection: (collection: unknown) => collection,
  parseEngineeringQuery: () => ({ chips: [] }),
}));

vi.mock("@/components/quote-intelligence/QuoteIntelligenceShell", () => ({
  QuoteIntelligenceShell: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/chat/WorkspaceAccountMenu", () => ({
  WorkspaceAccountMenu: () => null,
}));

function renderParts() {
  return render(
    <MemoryRouter initialEntries={["/parts"]}>
      <ClientParts />
    </MemoryRouter>,
  );
}

function rowLink(title: string) {
  return screen.getByText(title).closest("a") as HTMLAnchorElement;
}

describe("ClientParts prefetch (OVD-1033 P2-11)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useClientHomeControllerMock.mockReturnValue({
      user: { id: "user-1", email: "client@example.com" },
      activeMembership: { organizationId: "org-1", role: "client" },
      isAuthInitializing: false,
      isVerifiedAuth: true,
      accessibleJobs: ROWS.filter((row) => row.kind === "part").map((row) => ({ id: row.id })),
      accessibleJobsQuery: { isLoading: false, isError: false, refetch: vi.fn() },
      sidebarProjects: [],
      summariesByJobId: new Map(),
      navigationModel: { partToProjectIds: new Map() },
      workspaceAccessScope: "user-1:org-1:client",
      newJobFilePicker: {
        accept: "",
        handleFileInputChange: vi.fn(),
        inputRef: { current: null },
        openFilePicker: vi.fn(),
      },
      prefetchPart: prefetchPartMock,
      prefetchProject: prefetchProjectMock,
      signOut: vi.fn(),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not warm part or project detail on landing", () => {
    renderParts();
    act(() => {
      vi.advanceTimersByTime(1_000);
    });

    expect(screen.getAllByRole("link")).toHaveLength(13);
    expect(useClientHomeControllerMock).toHaveBeenCalledWith({ warmWorkspaceNavigation: false });
    expect(prefetchPartMock).not.toHaveBeenCalled();
    expect(prefetchProjectMock).not.toHaveBeenCalled();
  });

  it("prefetches exactly the hovered part", () => {
    renderParts();

    fireEvent.mouseEnter(rowLink("Part 3"));
    act(() => {
      vi.advanceTimersByTime(200);
    });

    expect(prefetchPartMock).toHaveBeenCalledTimes(1);
    expect(prefetchPartMock).toHaveBeenCalledWith("job-3");
    expect(prefetchProjectMock).not.toHaveBeenCalled();
  });

  it("prefetches a project row on keyboard focus", () => {
    renderParts();

    fireEvent.focus(rowLink("Project 2"));
    act(() => {
      vi.advanceTimersByTime(200);
    });

    expect(prefetchProjectMock).toHaveBeenCalledTimes(1);
    expect(prefetchProjectMock).toHaveBeenCalledWith("project-2");
    expect(prefetchPartMock).not.toHaveBeenCalled();
  });

  it("skips rows the pointer only passes over", () => {
    renderParts();

    for (const title of ["Part 1", "Part 2", "Part 3"]) {
      fireEvent.mouseEnter(rowLink(title));
      act(() => {
        vi.advanceTimersByTime(20);
      });
      fireEvent.mouseLeave(rowLink(title));
    }
    fireEvent.mouseEnter(rowLink("Part 4"));
    act(() => {
      vi.advanceTimersByTime(200);
    });

    expect(prefetchPartMock).toHaveBeenCalledTimes(1);
    expect(prefetchPartMock).toHaveBeenCalledWith("job-4");
  });
});
