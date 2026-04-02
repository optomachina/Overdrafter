import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getActiveClientWorkspaceGateway,
  getFixtureSessionDataForSearch,
  getFixtureScenarioIdFromSearch,
  resetClientWorkspaceFixtureStateForTests,
} from "@/features/quotes/client-workspace-fixtures";
import { buildClientPartRequestUpdateInput } from "@/features/quotes/rfq-metadata";
import { buildRequirementDraft } from "@/features/quotes/utils";

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

    expect(jobs).toHaveLength(1);
    expect(workspace[0]?.job.title).toBe("1093-05589 rev 2");
    expect(workspace[0]?.job.selected_vendor_quote_offer_id).toBe("fx-offer-xometry-international-economy");
    expect(workspace[0]?.part?.approvedRequirement?.part_number).toBe("1093-05589");
    expect(workspace[0]?.part?.approvedRequirement?.revision).toBe("2");
    expect(workspace[0]?.part?.vendorQuotes).toHaveLength(16);
    expect(workspace[0]?.part?.drawingFile?.original_name).toBe("1093-05589-02.pdf");
    expect(workspace[0]?.part?.cadFile?.original_name).toBe("1093-05589-02.STEP");
  });

  it("updates the selected offer and archive state inside the fixture store", async () => {
    window.history.replaceState({}, "", "/projects/fx-project-quoted?fixture=client-quoted");

    const gateway = getActiveClientWorkspaceGateway();
    expect(gateway).not.toBeNull();

    await gateway!.setJobSelectedVendorQuoteOffer("fx-job-quoted-a", "fx-offer-fictiv-overseas-cost-effective");
    const summaries = await gateway!.fetchJobPartSummariesByJobIds(["fx-job-quoted-a"]);
    expect(summaries[0]?.selectedSupplier).toBe("Fictiv");

    await gateway!.archiveJob("fx-job-quoted-a");

    const jobs = await gateway!.fetchAccessibleJobs();
    const archivedJobs = await gateway!.fetchArchivedJobs();

    expect(jobs).toHaveLength(0);
    expect(archivedJobs[0]?.job.id).toBe("fx-job-quoted-a");
  });

  it("reports missing archived jobs during bulk fixture deletes", async () => {
    window.history.replaceState({}, "", "/projects/fx-project-quoted?fixture=client-quoted");

    const gateway = getActiveClientWorkspaceGateway();
    expect(gateway).not.toBeNull();

    await gateway!.archiveJob("fx-job-quoted-a");

    const result = await gateway!.deleteArchivedJobs(["fx-job-quoted-a", "fx-job-missing"]);
    const archivedJobs = await gateway!.fetchArchivedJobs();

    expect(result).toEqual({
      deletedJobIds: ["fx-job-quoted-a"],
      failures: [
        {
          jobId: "fx-job-missing",
          message: "Part not found, not archived, or you do not have permission to delete it.",
        },
      ],
    });
    expect(archivedJobs).toEqual([]);
  });

  it("preserves project property defaults and timestamps when a save matches the defaults", async () => {
    window.history.replaceState({}, "", "/projects/fx-project-quoted?fixture=client-quoted");

    const gateway = getActiveClientWorkspaceGateway();
    expect(gateway).not.toBeNull();

    const [workspaceItem] = await gateway!.fetchClientQuoteWorkspaceByJobIds(["fx-job-quoted-a"]);
    const part = workspaceItem?.part;
    expect(part).toBeTruthy();

    const input = buildClientPartRequestUpdateInput(
      "fx-job-quoted-a",
      buildRequirementDraft(part!, {
        requested_service_kinds: workspaceItem?.job.requested_service_kinds ?? [],
        primary_service_kind: workspaceItem?.job.primary_service_kind ?? null,
        service_notes: workspaceItem?.job.service_notes ?? null,
        requested_quote_quantities: workspaceItem?.job.requested_quote_quantities ?? [],
        requested_by_date: workspaceItem?.job.requested_by_date ?? null,
      }),
    );

    await gateway!.updateClientPartRequest(input);

    const [updatedWorkspaceItem] = await gateway!.fetchClientQuoteWorkspaceByJobIds(["fx-job-quoted-a"]);
    const propertyState = updatedWorkspaceItem?.part?.clientRequirement?.projectPartProperties;

    expect(propertyState).toMatchObject({
      defaults: expect.objectContaining({
        description: input.description,
        partNumber: input.partNumber,
        material: input.material,
        finish: input.finish,
        tightestToleranceInch: input.tightestToleranceInch,
        threads: input.threads,
      }),
      overrides: {},
    });
    expect(propertyState?.createdAt).toEqual(expect.any(String));
    expect(propertyState?.updatedAt).toEqual(expect.any(String));
  });

  it("preserves project property defaults and timestamps when the last override is reset", async () => {
    window.history.replaceState({}, "", "/projects/fx-project-quoted?fixture=client-quoted");

    const gateway = getActiveClientWorkspaceGateway();
    expect(gateway).not.toBeNull();

    const [workspaceItem] = await gateway!.fetchClientQuoteWorkspaceByJobIds(["fx-job-quoted-a"]);
    const part = workspaceItem?.part;
    expect(part).toBeTruthy();

    const input = buildClientPartRequestUpdateInput(
      "fx-job-quoted-a",
      buildRequirementDraft(part!, {
        requested_service_kinds: workspaceItem?.job.requested_service_kinds ?? [],
        primary_service_kind: workspaceItem?.job.primary_service_kind ?? null,
        service_notes: workspaceItem?.job.service_notes ?? null,
        requested_quote_quantities: workspaceItem?.job.requested_quote_quantities ?? [],
        requested_by_date: workspaceItem?.job.requested_by_date ?? null,
      }),
    );

    await gateway!.updateClientPartRequest({
      ...input,
      finish: "Reset me",
    });

    await gateway!.resetClientPartPropertyOverrides({
      jobId: "fx-job-quoted-a",
      fields: ["finish"],
    });

    const [updatedWorkspaceItem] = await gateway!.fetchClientQuoteWorkspaceByJobIds(["fx-job-quoted-a"]);
    const propertyState = updatedWorkspaceItem?.part?.clientRequirement?.projectPartProperties;

    expect(updatedWorkspaceItem?.part?.clientRequirement?.finish).toBe(input.finish ?? null);
    expect(propertyState).toMatchObject({
      defaults: expect.objectContaining({
        finish: input.finish ?? null,
      }),
      overrides: {},
    });
    expect(propertyState?.createdAt).toEqual(expect.any(String));
    expect(propertyState?.updatedAt).toEqual(expect.any(String));
  });

  it("seeds resettable defaults on legacy fixture rows before applying a reset", async () => {
    window.history.replaceState({}, "", "/projects/fx-project-quoted?fixture=client-quoted");

    const gateway = getActiveClientWorkspaceGateway();
    expect(gateway).not.toBeNull();

    const [workspaceItem] = await gateway!.fetchClientQuoteWorkspaceByJobIds(["fx-job-quoted-a"]);
    const effectiveDescription = workspaceItem?.part?.approvedRequirement?.description;

    await gateway!.resetClientPartPropertyOverrides({
      jobId: "fx-job-quoted-a",
      fields: ["description"],
    });

    const [updatedWorkspaceItem] = await gateway!.fetchClientQuoteWorkspaceByJobIds(["fx-job-quoted-a"]);
    const propertyState = updatedWorkspaceItem?.part?.clientRequirement?.projectPartProperties;

    expect(updatedWorkspaceItem?.part?.clientRequirement?.description).toBe(effectiveDescription);
    expect(updatedWorkspaceItem?.part?.approvedRequirement?.spec_snapshot).toMatchObject({
      description: effectiveDescription,
    });
    expect(propertyState).toMatchObject({
      defaults: expect.objectContaining({
        description: effectiveDescription,
      }),
      overrides: {},
      createdAt: null,
    });
    expect(propertyState?.updatedAt).toEqual(expect.any(String));
  });

  it("uses effective default-backed values in fixture mode when a nullable override is cleared", async () => {
    window.history.replaceState({}, "", "/projects/fx-project-quoted?fixture=client-quoted");

    const gateway = getActiveClientWorkspaceGateway();
    expect(gateway).not.toBeNull();

    const [workspaceItem] = await gateway!.fetchClientQuoteWorkspaceByJobIds(["fx-job-quoted-a"]);
    const part = workspaceItem?.part;
    expect(part).toBeTruthy();

    const input = buildClientPartRequestUpdateInput(
      "fx-job-quoted-a",
      buildRequirementDraft(part!, {
        requested_service_kinds: workspaceItem?.job.requested_service_kinds ?? [],
        primary_service_kind: workspaceItem?.job.primary_service_kind ?? null,
        service_notes: workspaceItem?.job.service_notes ?? null,
        requested_quote_quantities: workspaceItem?.job.requested_quote_quantities ?? [],
        requested_by_date: workspaceItem?.job.requested_by_date ?? null,
      }),
    );

    await gateway!.updateClientPartRequest({
      ...input,
      description: null,
    });

    const [updatedWorkspaceItem] = await gateway!.fetchClientQuoteWorkspaceByJobIds(["fx-job-quoted-a"]);
    const summaries = await gateway!.fetchJobPartSummariesByJobIds(["fx-job-quoted-a"]);
    const propertyState = updatedWorkspaceItem?.part?.clientRequirement?.projectPartProperties;

    expect(updatedWorkspaceItem?.part?.clientRequirement?.description).toBe(input.description);
    expect(updatedWorkspaceItem?.part?.approvedRequirement?.description).toBe(input.description);
    expect(updatedWorkspaceItem?.job.description).toBe(input.description);
    expect(summaries[0]?.description).toBe(input.description);
    expect(propertyState?.overrides).toMatchObject({
      description: null,
    });
  });
});
