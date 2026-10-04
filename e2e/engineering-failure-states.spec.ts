import { test, expect } from "./test";
import { readFileSync } from "node:fs";
import type { Locator, Route } from "@playwright/test";

// The backend is a Node-side mock of failed and canceled task rows. This deliberately
// does not claim database durability, real authentication, or native execution.
test.describe("engineering failed-change truthfulness simulation", { tag: "@fixture" }, () => {
  test("shows a failed change, its blocked successor and their cancellation without writes or retries", async ({ page, baseURL }, testInfo) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width: 1280, height: 900 });
    const bundle = JSON.parse(readFileSync("server/engineering/fixtures/preview-7mm/preview.json", "utf8"));
    const conversationId = "10000000-0000-4000-8000-000000000201";
    const firstTaskId = "10000000-0000-4000-8000-000000000202";
    const secondTaskId = "10000000-0000-4000-8000-000000000203";
    const failedAttemptId = "10000000-0000-4000-8000-000000000204";
    const headSnapshotId = "10000000-0000-4000-8000-000000000205";
    const scope = { conversation_id: conversationId, organization_id: bundle.scope.organizationId,
      project_id: bundle.scope.projectId, owner_user_id: "fixture-user-client" };
    const head = { id: conversationId, ...scope, revision: 2, head_snapshot_id: headSnapshotId };
    // History is served newest first, as the reader requests it.
    const messages = [
      { id: "10000000-0000-4000-8000-000000000207", role: "user", body: "Depth 9 mm", sequence: 2 },
      { id: "10000000-0000-4000-8000-000000000206", role: "user", body: "Depth 7 mm", sequence: 1 },
    ];
    const forbiddenRequests: string[] = [];
    const reviewRpcRequests: string[] = [];
    let state: "failed" | "canceled" = "failed";
    let taskReads = 0;
    let stepTaskReads = 0;

    // Cancellation changes only execution_state, so the failed verdict and attempt pointer remain
    // (api_cancel_engineering_suffix in 20260910104500_engineering_native_ownership.sql).
    const taskRows = () => [
      { id: secondTaskId, execution_state: state === "failed" ? "blocked" : "canceled",
        verification_state: "unverified", adoption_state: "unadopted", engineering_decisions: { sequence: 2 },
        task_execution: [{ ...scope, task_id: secondTaskId, current_attempt_id: null, current_attempt: null }] },
      { id: firstTaskId, execution_state: state, verification_state: "failed",
        adoption_state: "unadopted", engineering_decisions: { sequence: 1 },
        task_execution: [{ ...scope, task_id: firstTaskId, current_attempt_id: failedAttemptId,
          current_attempt: { ...scope, task_id: firstTaskId, id: failedAttemptId, phase: "failed" } }] },
    ];

    const serve = async (route: Route) => {
      const request = route.request();
      const url = new URL(request.url());
      const method = request.method();
      if (url.origin === baseURL && ["GET", "HEAD"].includes(method)) return route.continue();
      if (url.pathname.endsWith("/rpc/api_read_native_step_review")) reviewRpcRequests.push(`${method} ${url.pathname}`);
      if (url.origin !== "http://127.0.0.1:9" || method !== "GET") {
        forbiddenRequests.push(`${method} ${url.origin}${url.pathname}`);
        return route.abort();
      }
      expect(url.searchParams.get("owner_user_id")).toBe(`eq.${scope.owner_user_id}`);
      if (url.pathname === "/rest/v1/engineering_conversations") {
        expect(url.searchParams.get("id")).toBe(`eq.${conversationId}`);
        return route.fulfill({ json: head });
      }
      expect(url.searchParams.get("conversation_id")).toBe(`eq.${conversationId}`);
      expect(url.searchParams.get("organization_id")).toBe(`eq.${scope.organization_id}`);
      expect(url.searchParams.get("project_id")).toBe(`eq.${scope.project_id}`);
      if (url.pathname === "/rest/v1/engineering_messages") {
        return route.fulfill({ json: messages.map((message) => ({ ...message, ...scope })) });
      }
      if (url.pathname === "/rest/v1/engineering_tasks") {
        if (url.searchParams.get("limit") === "1") {
          // The exact STEP review first looks for a succeeded and passed task; none exists here.
          expect(url.searchParams.get("execution_state")).toBe("eq.succeeded");
          expect(url.searchParams.get("verification_state")).toBe("eq.passed");
          stepTaskReads += 1;
          return route.fulfill({ json: [] });
        }
        taskReads += 1;
        return route.fulfill({ json: taskRows() });
      }
      forbiddenRequests.push(`${method} ${url.origin}${url.pathname}`);
      return route.abort();
    };

    await page.context().route("**/*", serve);
    await page.goto(`/engineering?conversation=${conversationId}&fixture=client-quoted`);
    // A cold dev server can spend several seconds serving unbundled modules before the first read.
    await expect(page.getByRole("status")).toContainText("Conversation loaded", { timeout: 15_000 });
    const recorded = page.getByRole("article", { name: "Your message", exact: true });
    await expect(recorded).toHaveText([/Depth 7 mm/, /Depth 9 mm/]);

    // "Failed" is both an execution and a verification label, so every value is read from its own field.
    const field = (card: Locator, name: string) => card.locator("div")
      .filter({ has: page.locator("dt", { hasText: new RegExp(`^${name}$`) }) }).locator("dd");
    const first = page.getByRole("article", { name: "Change 1", exact: true });
    const second = page.getByRole("article", { name: "Change 2", exact: true });
    const expectFields = async (card: Locator, values: Record<string, string>) => {
      for (const [name, value] of Object.entries(values)) await expect(field(card, name)).toHaveText(value);
    };
    const expectGeometryUnavailable = async () => {
      await expect(page.getByRole("heading", { name: "Candidate geometry unavailable" })).toBeVisible();
      // The review settles before this heading appears, so any review RPC has already been attempted.
      expect(forbiddenRequests).toEqual([]);
      expect(reviewRpcRequests).toEqual([]);
      await expect(page.getByText("No candidate result has been verified for this conversation.", { exact: true })).toBeVisible();
      await expect(page.getByRole("region", { name: "Exact STEP review" }).locator("canvas")).toHaveCount(0);
    };
    const expectNoActions = async () => {
      await expect(first.getByRole("button")).toHaveCount(0);
      await expect(second.getByRole("button")).toHaveCount(0);
      await expect(page.getByRole("button", { name: /retry|cancel/i })).toHaveCount(0);
    };

    const changeStatus = page.getByRole("region", { name: "Accepted change status" });
    await expect(page.getByRole("article", { name: /^Change \d+$/ })).toHaveCount(2);
    await expectFields(first, { Execution: "Failed", Verification: "Failed", Adoption: "Not adopted",
      "Current attempt": "Attempt failed" });
    await expectFields(second, { Execution: "Blocked", Verification: "Unverified", Adoption: "Not adopted",
      "Current attempt": "No current attempt recorded" });
    await expectNoActions();
    await expectGeometryUnavailable();
    await changeStatus.screenshot({ path: testInfo.outputPath("failed-change-blocked-successor.png") });

    // Only the simulated backend changes; the page must observe it through its own task polling.
    state = "canceled";
    const readsBeforeCancel = taskReads;
    await expect.poll(() => taskReads, { timeout: 10_000 }).toBeGreaterThan(readsBeforeCancel);
    await expectFields(first, { Execution: "Canceled", Verification: "Failed", Adoption: "Not adopted",
      "Current attempt": "Attempt failed" });
    await expectFields(second, { Execution: "Canceled", Verification: "Unverified", Adoption: "Not adopted",
      "Current attempt": "No current attempt recorded" });
    await expect(page.getByRole("article", { name: /^Change \d+$/ })).toHaveCount(2);
    await expectNoActions();
    await expectGeometryUnavailable();

    await changeStatus.screenshot({ path: testInfo.outputPath("canceled-failed-change-and-successor.png") });
    // The open conversation overlays the CAD workspace; collapse it to capture the geometry state.
    await page.getByRole("button", { name: "Conversation", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Candidate geometry unavailable" })).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath("canceled-geometry-unavailable.png") });

    expect(forbiddenRequests).toEqual([]);
    expect(reviewRpcRequests).toEqual([]);
    expect(stepTaskReads).toBeGreaterThan(0);
    await testInfo.attach("failure-states-simulation-evidence", { contentType: "application/json",
      body: JSON.stringify({ simulationOnly: true, conversationId, firstTaskId, secondTaskId, failedAttemptId,
        headSnapshotId, observedStates: ["failed", "canceled"], taskReads, readsBeforeCancel, stepTaskReads,
        reviewRpcRequests, forbiddenRequests }, null, 2) });
  });
});
