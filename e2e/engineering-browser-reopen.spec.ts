import { test, expect } from "./test";
import { readFileSync } from "node:fs";
import type { Browser, Route } from "@playwright/test";

// The Node-side mock survives actual browser-process closure. This deliberately
// does not claim database durability, real authentication, or native execution.
test.describe("engineering browser-process reopen simulation", { tag: "@fixture" }, () => {
  for (const terminal of ["verified", "recovery_required"] as const) {
    test(`recovers the original 7 mm request after ${terminal} without writes or retries`, async ({ playwright, browserName, baseURL }, testInfo) => {
      test.setTimeout(60_000);
      const bundle = JSON.parse(readFileSync("server/engineering/fixtures/preview-7mm/preview.json", "utf8"));
      const candidate = JSON.parse(readFileSync("server/engineering/fixtures/preview-7mm/context.json", "utf8"));
      expect(candidate.depthMm).toBe(7);
      expect(candidate.snapshotId).toBe(bundle.snapshotId);
      const conversationId = "10000000-0000-4000-8000-000000000101";
      const messageId = "10000000-0000-4000-8000-000000000102";
      const requestId = "10000000-0000-4000-8000-000000000103";
      const exportId = "10000000-0000-4000-8000-000000000104";
      const taskId = candidate.producer.jobId;
      const attemptId = candidate.producer.attemptId;
      const sourceSnapshotId = candidate.producer.inputSnapshotId;
      const scope = { conversation_id: conversationId, organization_id: bundle.scope.organizationId,
        project_id: bundle.scope.projectId, owner_user_id: "fixture-user-client" };
      let head = { id: conversationId, ...scope, revision: 2, head_snapshot_id: sourceSnapshotId };
      const instruction = "Set depth to 7 mm.";
      const messages: { id: string; role: string; body: string; sequence: number }[] = [];
      const submissions: Record<string, unknown>[] = [];
      const forbiddenRequests: string[] = [];
      const reviewRequests: Record<string, unknown>[] = [];
      let state: "empty" | "running" | typeof terminal = "empty";
      let taskReads = 0;
      const ready = Object.freeze({ status: "ready", taskId, attemptId,
        sourceSnapshotId, candidateSnapshotId: bundle.snapshotId,
        candidateContextSha256: bundle.contextSha256, resultSha256: bundle.resultSha256,
        exportId, sourceCommit: bundle.export.sourceCommit,
        reportSha256: bundle.export.reportSha256, stepSha256: bundle.step.sha256,
        stepBytes: bundle.step.bytes, stepBase64: bundle.step.base64 });

      const serve = async (route: Route) => {
        const request = route.request();
        const url = new URL(request.url());
        const method = request.method();
        if (url.origin === baseURL && ["GET", "HEAD"].includes(method)) return route.continue();
        const reject = () => {
          forbiddenRequests.push(`${method} ${url.origin}${url.pathname}`);
          return route.abort();
        };
        if (url.origin !== "http://127.0.0.1:9") return reject();
        if (url.pathname === "/rest/v1/rpc/api_submit_engineering_message" && method === "POST") {
          const args = request.postDataJSON();
          submissions.push(args);
          expect(submissions).toHaveLength(1);
          expect(args).toMatchObject({ p_conversation_id: conversationId,
            p_organization_id: scope.organization_id, p_project_id: scope.project_id,
            p_input_snapshot_id: sourceSnapshotId, p_expected_revision: 2, p_body: instruction });
          expect(args.p_idempotency_key).toMatch(/^[0-9a-f-]{36}$/);
          head = { ...head, revision: 3 };
          messages.push({ id: messageId, role: "user", body: args.p_body, sequence: 3 });
          state = "running";
          return route.fulfill({ json: { conversationId, inputSnapshotId: sourceSnapshotId,
            messageId, requestId, revision: 3 } });
        }
        if (url.pathname === "/rest/v1/rpc/api_read_native_step_review" && method === "POST") {
          const args = request.postDataJSON();
          reviewRequests.push(args);
          expect(state).toBe("verified");
          expect(args).toEqual({ p_conversation_id: conversationId,
            p_task_id: taskId, p_candidate_snapshot_id: bundle.snapshotId });
          return route.fulfill({ json: ready });
        }
        if (method !== "GET") return reject();
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
          const verified = state === "verified";
          if (url.searchParams.get("limit") === "1") {
            return route.fulfill({ json: verified ? [{ id: taskId, ...scope,
              execution_state: "succeeded", verification_state: "passed" }] : [] });
          }
          taskReads += 1;
          return route.fulfill({ json: state === "empty" ? [] : [{ id: taskId,
            execution_state: verified ? "succeeded" : state === "running" ? "running" : "failed",
            verification_state: verified ? "passed" : "unverified", adoption_state: "unadopted",
            engineering_decisions: { sequence: 1 }, task_execution: [{ ...scope, task_id: taskId,
              current_attempt_id: attemptId, current_attempt: { ...scope, task_id: taskId,
                id: attemptId, phase: verified ? "awaiting_result" : state } }] }] });
        }
        return reject();
      };

      let browser: Browser | undefined;
      let browserStarts = 0;
      let browserCloses = 0;
      const openFreshBrowser = async () => {
        if (browser) expect(browser.isConnected()).toBe(false);
        browser = await playwright[browserName].launch(testInfo.project.use.launchOptions);
        browserStarts += 1;
        const context = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 },
          serviceWorkers: "block" });
        expect(await context.storageState()).toEqual({ cookies: [], origins: [] });
        await context.route("**/*", serve);
        await context.tracing.start({ screenshots: true, snapshots: true });
        const page = await context.newPage();
        await page.goto(`/engineering?conversation=${conversationId}&fixture=client-quoted`);
        await expect(page.getByRole("status")).toContainText("Conversation loaded");
        expect(await page.evaluate(() => localStorage.getItem("reopen-simulation-marker"))).toBeNull();
        return page;
      };
      const closeBrowser = async (name: string) => {
        await browser!.contexts()[0].tracing.stop({ path: testInfo.outputPath(`${name}.zip`) });
        await browser!.close();
        expect(browser!.isConnected()).toBe(false);
        browserCloses += 1;
      };
      try {
        let page = await openFreshBrowser();
        await page.evaluate(() => localStorage.setItem("reopen-simulation-marker", "first browser only"));
        await page.getByRole("textbox", { name: "Message" }).fill(instruction);
        await page.getByRole("button", { name: "Send message" }).click();
        await expect(page.getByRole("status")).toHaveText("Request recorded. CAD execution has not been confirmed.");
        await expect(page.getByRole("article", { name: "Your message", exact: true })).toHaveCount(1);
        await expect(page.getByText(instruction, { exact: true })).toBeVisible();
        const active = page.getByRole("article", { name: "Change 1", exact: true });
        await expect(active.getByText("Running", { exact: true })).toBeVisible();
        await expect(active.getByText("Active", { exact: true })).toBeVisible();
        await expect(active.getByText("Unverified", { exact: true })).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath("recorded-before-browser-close.png") });
        const originalSubmission = { ...submissions[0] };
        await closeBrowser("before-browser-close");

        // Only the simulated backend changes while there is no connected browser.
        state = terminal;
        if (terminal === "verified") head = { ...head, revision: 4, head_snapshot_id: bundle.snapshotId };
        const terminalHead = { ...head };
        // A second close/reopen also protects against relying on an already-loaded preview.
        for (let reopen = 1; reopen <= 2; reopen += 1) {
          page = await openFreshBrowser();
          const recorded = page.getByRole("article", { name: "Your message", exact: true });
          await expect(recorded).toHaveCount(1);
          await expect(recorded.getByText(instruction, { exact: true })).toBeVisible();
          await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue("");
          await expect(page.getByRole("button", { name: /retry/i })).toHaveCount(0);
          const change = page.getByRole("article", { name: "Change 1", exact: true });
          await expect(change.getByText("Not adopted", { exact: true })).toBeVisible();
          await expect(change.getByRole("button")).toHaveCount(0);
          await expect(change.getByText(terminal === "verified" ? "Succeeded" : "Failed", { exact: true })).toBeVisible();
          await expect(change.getByText(terminal === "verified" ? "Passed" : "Unverified", { exact: true })).toBeVisible();
          if (terminal === "recovery_required") {
            await expect(change.getByText("Recovery required", { exact: true })).toBeVisible();
            await expect(change.getByText("Execution needs reconciliation. No retry is requested here.")).toBeVisible();
            await expect(change.getByText("Passed", { exact: true })).toHaveCount(0);
            await expect(page.getByRole("heading", { name: "Candidate geometry unavailable" })).toBeVisible();
            await expect(page.getByRole("region", { name: "Exact STEP review" }).locator("canvas")).toHaveCount(0);
            expect(reviewRequests).toHaveLength(0);
          }
          // Observe a real polling cycle and a manual refresh after each relaunch.
          const readsBeforePoll = taskReads;
          await expect.poll(() => taskReads, { timeout: 10_000 }).toBeGreaterThan(readsBeforePoll);
          await page.locator("summary").filter({ hasText: "Workbench tools" }).click();
          const refresh = page.getByRole("button", { name: "Refresh conversation" });
          const [refreshedHistory] = await Promise.all([
            page.waitForResponse((response) => {
              const url = new URL(response.url());
              return url.origin === "http://127.0.0.1:9" && url.pathname === "/rest/v1/engineering_messages"
                && response.request().method() === "GET";
            }),
            refresh.click(),
          ]);
          expect(refreshedHistory.ok()).toBe(true);
          expect(await refreshedHistory.finished()).toBeNull();
          await expect(refresh).toBeEnabled();
          await expect(page.getByRole("status")).toContainText("Conversation loaded");
          await page.locator("summary").filter({ hasText: "Workbench tools" }).click();
          if (terminal === "recovery_required") {
            await expect(page.getByRole("heading", { name: "Candidate geometry unavailable" })).toBeVisible();
            await expect(page.getByRole("region", { name: "Exact STEP review" }).locator("canvas")).toHaveCount(0);
            expect(reviewRequests).toHaveLength(0);
          }
          await page.screenshot({ path: testInfo.outputPath(`reopened-${terminal}-${reopen}-conversation.png`) });
          if (terminal === "verified") {
            await page.getByRole("button", { name: "Conversation", exact: true }).click();
            await expect(page.getByRole("heading", { name: "Verified candidate geometry" })).toBeVisible();
            await page.getByText("Exact result binding").click();
            await expect(page.getByText(`STEP SHA-256: ${ready.stepSha256}`, { exact: true })).toBeVisible();
            await expect(page.getByText(`Candidate snapshot: ${ready.candidateSnapshotId}`, { exact: true })).toBeVisible();
            await expect(page.getByText(`Source snapshot: ${sourceSnapshotId}`, { exact: true })).toBeVisible();
            await expect(page.getByRole("region", { name: "Exact STEP review" }).locator("canvas"))
              .toBeVisible({ timeout: 15_000 });
            await page.screenshot({ path: testInfo.outputPath(`reopened-verified-${reopen}-exact-step.png`) });
          }
          expect(submissions).toEqual([originalSubmission]);
          expect(messages).toEqual([{ id: messageId, role: "user", body: instruction, sequence: 3 }]);
          expect(head).toEqual(terminalHead);
          expect(forbiddenRequests).toEqual([]);
          await closeBrowser(`reopened-${terminal}-${reopen}`);
          expect(submissions).toEqual([originalSubmission]);
          expect(forbiddenRequests).toEqual([]);
        }
        expect(browserStarts).toBe(3);
        expect(browserCloses).toBe(3);
        await testInfo.attach("browser-reopen-simulation-evidence", { contentType: "application/json",
          body: JSON.stringify({ simulationOnly: true, terminal, conversationId, requestId, messageId,
            taskId, attemptId, sourceSnapshotId, candidateSnapshotId: head.head_snapshot_id,
            stepSha256: terminal === "verified" ? ready.stepSha256 : null,
            browserProcessCloses: browserCloses, freshBrowserReopens: browserStarts - 1, submissions, forbiddenRequests, reviewRequests }, null, 2) });
      } finally {
        if (browser?.isConnected()) {
          await browser.contexts()[0]?.tracing.stop({ path: testInfo.outputPath("interrupted-browser.zip") }).catch(() => {});
        }
        await browser?.close();
      }
    });
  }
});
