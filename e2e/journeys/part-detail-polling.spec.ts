import { test, expect } from "../test";

// Fixture mode returns an already-normalized aggregate and bypasses the metadata
// RPC. Use the seeded local stack and client session to exercise the real boundary.
const JOB_ID = "00000000-0000-4000-8000-000000000100";
const POLLED_PATHS = new Set([
  "/rest/v1/rpc/api_list_client_part_metadata",
  "/rest/v1/rpc/api_list_client_quote_workspace",
  "/rest/v1/rpc/api_list_client_activity_events",
  "/rest/v1/activity_events",
]);

test.describe("settled part detail polling", () => {
  test.use({ storageState: "playwright/.auth/client.json" });

  test("shows settled metadata and stops part detail and activity polling", async ({ page }) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width: 375, height: 812 });
    const requests: string[] = [];
    page.on("request", (request) => {
      const pathname = new URL(request.url()).pathname;
      if (POLLED_PATHS.has(pathname)) requests.push(pathname);
    });
    const metadataResponse = page.waitForResponse((response) =>
      new URL(response.url()).pathname === "/rest/v1/rpc/api_list_client_part_metadata" &&
      response.request().postDataJSON()?.p_job_ids?.includes(JOB_ID) && response.ok(),
    );

    await page.goto(`/parts/${JOB_ID}?debug=1`);
    await page.bringToFront();
    const rows = await (await metadataResponse).json();
    const row = rows.find((candidate: { jobId: string }) => candidate.jobId === JOB_ID);
    expect(row, "seeded FX-100 metadata must be present").toBeTruthy();
    expect(["succeeded", "partial"]).toContain((row.clientExtraction ?? row).lifecycle);
    await expect(page.getByLabel("Part number", { exact: true })).toHaveValue("FX-100");
    await expect(page.getByText("Waiting for drawing metadata", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Drawing extraction in progress", { exact: true })).toHaveCount(0);

    // Drain initial sidebar/detail reads, then observe more than two 5 s intervals.
    // Real elapsed time is deliberate: the bug is recurring browser network work.
    await page.waitForLoadState("networkidle");
    expect(requests).toContain("/rest/v1/rpc/api_list_client_part_metadata");
    const settledRequestCount = requests.length;
    await page.waitForTimeout(11_000);
    expect(requests.slice(settledRequestCount)).toEqual([]);
    await expect(page.getByLabel("Part number", { exact: true })).toHaveValue("FX-100");
  });
});
