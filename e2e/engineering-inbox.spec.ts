import { test, expect } from "./test";

test.use({ video: "on" });
test.describe("private engineering intake screen", { tag: "@fixture" }, () => {
  test("records, retries and explicitly reconciles in the bottom composer", async ({ page }, testInfo) => {
    const id = "10000000-0000-4000-8000-000000000001";
    const firstSnapshot = "10000000-0000-4000-8000-000000000002";
    const nextSnapshot = "10000000-0000-4000-8000-000000000003";
    let head = { id, organization_id: id, project_id: id, owner_user_id: "fixture-user-client", revision: 2, head_snapshot_id: firstSnapshot };
    const history = [{ id: "earlier", role: "user", body: "Compare the plate thicknesses.", sequence: 1 }];
    const requests: Record<string, unknown>[] = [];
    let task = { id: firstSnapshot, execution_state: "running", verification_state: "unverified", adoption_state: "unadopted", engineering_decisions: { sequence: 1 } };
    let taskReads = 0;
    await page.route("http://127.0.0.1:9/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith("/engineering_conversations")) return route.fulfill({ json: head });
      if (path.endsWith("/engineering_messages")) return route.fulfill({ json: [...history].reverse() });
      if (path.endsWith("/engineering_tasks")) {
        taskReads += 1;
        const parameters = new URL(route.request().url()).searchParams;
        expect(parameters.get("owner_user_id")).toBe("eq.fixture-user-client");
        expect(parameters.get("conversation_id")).toBe(`eq.${id}`);
        return route.fulfill({ json: [task] });
      }
      if (path.endsWith("/rpc/api_submit_engineering_message")) {
        const args = route.request().postDataJSON();
        requests.push(args);
        if (requests.length === 1) return route.fulfill({ json: { unexpected: "receipt" } });
        if (requests.length === 3) {
          head = { ...head, revision: 9, head_snapshot_id: nextSnapshot };
          return route.fulfill({ status: 409, json: { code: "PT409", message: "Context changed" } });
        }
        head = { ...head, revision: Number(args.p_expected_revision) + 1 };
        history.push({ id: `message-${requests.length}`, role: "user", body: args.p_body, sequence: head.revision });
        return route.fulfill({ json: { conversationId: id, inputSnapshotId: args.p_input_snapshot_id,
          messageId: firstSnapshot, requestId: nextSnapshot, revision: head.revision } });
      }
      return route.abort();
    });
    await page.goto(`/engineering?conversation=${id}&fixture=client-quoted`);
    await expect(page.getByRole("status")).toContainText("Conversation loaded");
    const change = page.getByRole("article", { name: "Change 1", exact: true });
    await expect(change.getByText("Running", { exact: true })).toBeVisible();
    await expect(change.getByText("Unverified", { exact: true })).toBeVisible();
    task = { ...task, execution_state: "succeeded", verification_state: "checking" };
    await expect(change.getByText("Checking", { exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(change.getByText("Succeeded", { exact: true })).toBeVisible();
    await expect(change.getByText("Not adopted", { exact: true })).toBeVisible();
    expect(taskReads).toBeGreaterThanOrEqual(2);
    expect(requests).toHaveLength(0);
    await page.screenshot({ path: testInfo.outputPath("separate-task-states.png") });
    const composer = page.getByRole("textbox", { name: "Message" });
    await composer.fill("Set depth to 8 mm.");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.getByRole("status")).toContainText("Delivery is uncertain");
    await expect(composer).toBeDisabled();
    await page.screenshot({ path: testInfo.outputPath("uncertain-delivery.png") });
    await page.getByRole("button", { name: "Retry original request" }).click();
    await expect(page.getByRole("status")).toContainText("Request recorded");
    expect(requests[1]).toEqual(requests[0]);
    await composer.fill("Now set depth to 9 mm.");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.getByRole("status")).toContainText("The conversation changed");
    await page.getByRole("button", { name: "Review latest context" }).click();
    await expect(page.getByText("Revision 3 → 9")).toBeVisible();
    expect(requests).toHaveLength(3);
    await page.getByRole("button", { name: "Use updated context" }).click();
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.getByRole("status")).toContainText("Request recorded");
    expect(requests[3]).toMatchObject({ p_expected_revision: 9, p_input_snapshot_id: nextSnapshot });
    expect(requests[3].p_idempotency_key).not.toBe(requests[2].p_idempotency_key);
    await page.setViewportSize({ width: 390, height: 844 });
    await change.scrollIntoViewIfNeeded();
    await expect(change.getByText("Checking", { exact: true })).toBeVisible();
    await expect(change.getByText("Not adopted", { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("mobile-recorded.png") });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.reload();
    await expect(page.getByText("Now set depth to 9 mm.", { exact: true })).toBeVisible();
    await expect(page.getByRole("status")).toContainText("Conversation loaded");
  });
});
