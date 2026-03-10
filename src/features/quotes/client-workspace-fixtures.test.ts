import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getActiveClientWorkspaceGateway,
  getFixtureSessionDataForSearch,
  getFixtureScenarioIdFromSearch,
  resetClientWorkspaceFixtureStateForTests,
} from "@/features/quotes/client-workspace-fixtures";

describe("client workspace fixtures", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_ENABLE_FIXTURE_MODE", "1");
  });

  afterEach(() => {
    resetClientWorkspaceFixtureStateForTests();
    vi.unstubAllEnvs();
    window.history.replaceState({}, "", "/");
  });

  it("parses supported scenario IDs from the URL search string", () => {
    expect(getFixtureScenarioIdFromSearch("?fixture=client-quoted")).toBe("client-quoted");
    expect(getFixtureScenarioIdFromSearch("?fixture=unknown")).toBeNull();
  });

  it("returns fixture session data for a supported search string", () => {
    const session = getFixtureSessionDataForSearch("?fixture=client-empty");

    expect(session?.user?.email).toBe("client.fixture@example.com");
    expect(session?.memberships[0]?.role).toBe("client");
  });

  it("serves the quoted fixture workspace through the active gateway", async () => {
    window.history.replaceState({}, "", "/projects/fx-project-quoted?fixture=client-quoted");

    const gateway = getActiveClientWorkspaceGateway();
    expect(gateway).not.toBeNull();

    const jobs = await gateway!.fetchAccessibleJobs();
    const workspace = await gateway!.fetchClientQuoteWorkspaceByJobIds(["fx-job-quoted-a"]);

    expect(jobs).toHaveLength(2);
    expect(workspace[0]?.job.title).toContain("FX-101");
    expect(workspace[0]?.job.selected_vendor_quote_offer_id).toBe("fx-offer-quoted-a-xometry");
  });

  it("updates the selected offer and archive state inside the fixture store", async () => {
    window.history.replaceState({}, "", "/projects/fx-project-quoted?fixture=client-quoted");

    const gateway = getActiveClientWorkspaceGateway();
    expect(gateway).not.toBeNull();

    await gateway!.setJobSelectedVendorQuoteOffer("fx-job-quoted-a", "fx-offer-quoted-a-protolabs");
    let summaries = await gateway!.fetchJobPartSummariesByJobIds(["fx-job-quoted-a"]);
    expect(summaries[0]?.selectedSupplier).toBe("Proto Labs");

    await gateway!.archiveJob("fx-job-quoted-a");

    const jobs = await gateway!.fetchAccessibleJobs();
    const archivedJobs = await gateway!.fetchArchivedJobs();

    expect(jobs).toHaveLength(1);
    expect(archivedJobs[0]?.job.id).toBe("fx-job-quoted-a");
  });
});
