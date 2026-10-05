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
    // Every mocked read must be scoped by its query filters, never by the select string alone.
    const readFilters = new Map<string, Record<string, string>>([
      ["/rest/v1/engineering_conversations", { id: conversationId, owner_user_id: scope.owner_user_id }],
      ["/rest/v1/engineering_messages", scope],
      ["/rest/v1/engineering_tasks", scope],
    ]);
    const forbiddenRequests: string[] = [];
    const reviewRpcRequests: string[] = [];
    const assertedStates: string[] = [];
    let state: "failed" | "canceled" = "failed";
    let taskReads = 0;
    let stepTaskReads = 0;

    // No current code path writes verification_state 'failed'; it is a schema-permitted simulated state.
    // Cancellation keeps the failed verdict and the attempt pointer. api_cancel_engineering_suffix
    // (20260910055556_engineering_ordered_changes.sql:386) delegates to engineering_private.cancel_engineering_suffix,
    // whose current body (20260910104500_engineering_native_ownership.sql:700) admits these failed and blocked
    // rows (:747-755) and does not change verification_state or current_attempt_id (:758-760).
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
      const filters = url.origin === "http://127.0.0.1:9" && method === "GET" ? readFilters.get(url.pathname) : undefined;
      if (!filters) {
        forbiddenRequests.push(`${method} ${url.origin}${url.pathname}`);
        return route.abort();
      }
      for (const [column, value] of Object.entries(filters)) {
        expect(url.searchParams.get(column), `${url.pathname} ${column} filter`).toBe(`eq.${value}`);
      }
      if (url.pathname === "/rest/v1/engineering_conversations") return route.fulfill({ json: head });
      if (url.pathname === "/rest/v1/engineering_messages") {
        return route.fulfill({ json: messages.map((message) => ({ ...message, ...scope })) });
      }
      if (url.searchParams.get("limit") === "1") {
        // The exact STEP review first looks for a succeeded and passed task; none exists here.
        expect(url.searchParams.get("execution_state")).toBe("eq.succeeded");
        expect(url.searchParams.get("verification_state")).toBe("eq.passed");
        stepTaskReads += 1;
        return route.fulfill({ json: [] });
      }
      taskReads += 1;
      return route.fulfill({ json: taskRows() });
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
    // Every geometry check runs inside the one review region, so a missing region cannot pass the canvas count.
    const review = page.getByRole("region", { name: "Exact STEP review" });
    const expectGeometryUnavailable = async () => {
      await expect(review).toHaveCount(1);
      await expect(review.getByRole("heading", { name: "Candidate geometry unavailable" })).toBeVisible();
      // The review settles before this heading appears, so any review RPC has already been attempted.
      expect(forbiddenRequests).toEqual([]);
      expect(reviewRpcRequests).toEqual([]);
      await expect(review.getByText("No candidate result has been verified for this conversation.", { exact: true })).toBeVisible();
      await expect(review.locator("canvas")).toHaveCount(0);
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
    assertedStates.push(state);
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
    // Task polling does not re-read the STEP review, so a manual refresh forces a fresh
    // review read before geometry is re-checked against the canceled state.
    const stepReadsBeforeRefresh = stepTaskReads;
    await page.locator("summary").filter({ hasText: "Workbench tools" }).click();
    await page.getByRole("button", { name: "Refresh conversation" }).click();
    await expect.poll(() => stepTaskReads, { timeout: 10_000 }).toBeGreaterThan(stepReadsBeforeRefresh);
    await expect(page.getByRole("status")).toContainText("Conversation loaded");
    await page.locator("summary").filter({ hasText: "Workbench tools" }).click();
    await expectFields(first, { Execution: "Canceled", Verification: "Failed" });
    await expectFields(second, { Execution: "Canceled", Verification: "Unverified" });
    await expectGeometryUnavailable();
    assertedStates.push(state);

    await changeStatus.screenshot({ path: testInfo.outputPath("canceled-failed-change-and-successor.png") });
    // The open conversation overlays the CAD workspace; collapse it to capture the geometry state.
    await page.getByRole("button", { name: "Conversation", exact: true }).click();
    await expect(review.getByRole("heading", { name: "Candidate geometry unavailable" })).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath("canceled-geometry-unavailable.png") });

    expect(forbiddenRequests).toEqual([]);
    expect(reviewRpcRequests).toEqual([]);
    expect(stepTaskReads).toBeGreaterThan(0);
    // assertedStates gains each state only after every assertion of that phase has passed.
    await testInfo.attach("failure-states-simulation-evidence", { contentType: "application/json",
      body: JSON.stringify({ simulationOnly: true, conversationId, firstTaskId, secondTaskId, failedAttemptId,
        headSnapshotId, assertedStates, taskReads, readsBeforeCancel, stepTaskReads, stepReadsBeforeRefresh,
        reviewRpcRequests, forbiddenRequests }, null, 2) });
  });
});
