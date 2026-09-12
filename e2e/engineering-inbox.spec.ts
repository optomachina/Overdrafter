import { test, expect } from "./test";

test.use({ video: "on" });
test.describe("private engineering intake screen", { tag: "@fixture" }, () => {
  test("records, retries and explicitly reconciles in the bottom composer", async ({ page }, testInfo) => {
    test.setTimeout(45_000);
    const id = "10000000-0000-4000-8000-000000000001";
    const firstSnapshot = "10000000-0000-4000-8000-000000000002";
    const nextSnapshot = "10000000-0000-4000-8000-000000000003";
    let head = { id, organization_id: id, project_id: id, owner_user_id: "fixture-user-client", revision: 2, head_snapshot_id: firstSnapshot };
    const history = [{ id: "10000000-0000-4000-8000-000000000010", role: "user", body: "Compare the plate thicknesses.", sequence: 1 }];
    const requests: Record<string, unknown>[] = [];
    let task = { id: firstSnapshot, execution_state: "running", verification_state: "unverified", adoption_state: "unadopted", engineering_decisions: { sequence: 1 } };
    let taskReads = 0;
    let stallHead = false;
    let releaseHead: (() => void) | null = null;
    await page.route("http://127.0.0.1:9/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith("/engineering_conversations")) {
        if (stallHead) {
          stallHead = false;
          const delayed = { ...head, revision: 99 };
          await new Promise<void>((resolve) => { releaseHead = resolve; });
          // The read deadline cancels this browser request before the late fixture replies.
          return route.fulfill({ json: delayed }).catch(() => {});
        }
        return route.fulfill({ json: head });
      }
      if (path.endsWith("/engineering_messages")) return route.fulfill({ json: [...history].reverse().map((message) => ({ ...message, conversation_id: id, owner_user_id: head.owner_user_id, organization_id: id, project_id: id })) });
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
        history.push({ id: `10000000-0000-4000-8000-${String(requests.length + 100).padStart(12, "0")}`, role: "user", body: args.p_body, sequence: head.revision });
        expect(new Set(history.map((message) => message.id)).size).toBe(history.length);
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
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator("[data-agentation-root]")).toBeVisible();
    const annotation = page.getByTitle("Start feedback mode", { exact: true });
    await expect(annotation).toBeVisible();
    await annotation.focus();
    await expect(annotation).toBeFocused();
    await annotation.click();
    await expect(annotation).toHaveCount(0);
    const expandedToolbar = await page.locator("[data-agentation-toolbar]").boundingBox();
    expect(expandedToolbar!.x).toBeGreaterThanOrEqual(0);
    expect(expandedToolbar!.x + expandedToolbar!.width).toBeLessThanOrEqual(390);
    await page.keyboard.press("Escape");
    await expect(annotation).toBeVisible();
    const composer = page.getByRole("textbox", { name: "Message" });
    await composer.fill("Check clearance\nPreserve interfaces\nSet depth to 8 mm.");
    const send = page.getByRole("button", { name: "Send message" });
    const sendBox = await send.boundingBox();
    const annotationBox = await annotation.boundingBox();
    expect(sendBox).not.toBeNull();
    expect(annotationBox).not.toBeNull();
    expect(sendBox!.y + sendBox!.height).toBeLessThan(annotationBox!.y);
    const pill = await page.getByRole("group", { name: "Message composer" }).boundingBox();
    expect(Math.abs(pill!.x + pill!.width / 2 - 195)).toBeLessThan(1);
    await page.screenshot({ path: testInfo.outputPath("mobile-composer-and-toolbar.png") });
    await composer.fill("Set depth to 8 mm.");
    await page.getByRole("button", { name: "Send message" }).click({ timeout: 3000 });
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
    // A confirmed write must remain recorded even if the following context read stalls.
    stallHead = true;
    await composer.fill("Set depth to 7 mm.");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.getByRole("status")).toContainText("Request recorded. CAD execution has not been confirmed. Refresh to load", { timeout: 15_000 });
    expect(requests).toHaveLength(5);
    await page.getByRole("status").scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath("recorded-read-timeout.png") });
    await page.locator("summary").filter({ hasText: "Workbench tools" }).click();
    await page.getByRole("button", { name: "Refresh conversation" }).click();
    await expect(page.getByRole("status")).toContainText("Conversation loaded");
    releaseHead?.();
    await expect(page.getByText("Set depth to 7 mm.", { exact: true })).toBeVisible();
    expect(requests).toHaveLength(5);
    await page.locator("summary").filter({ hasText: "Workbench tools" }).click();
    await page.getByRole("status").scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath("read-recovered.png") });
    await page.setViewportSize({ width: 1280, height: 900 });
    expect(await page.getByRole("region", { name: "Engineering conversation" }).evaluate((element) => getComputedStyle(element).paddingBottom)).toBe("24px");
    await composer.fill("Set depth to 8 mm.");
    await send.click();
    await expect(page.getByRole("status")).toContainText("Request recorded");
    expect(requests).toHaveLength(6);
    await expect(page.getByRole("textbox", { name: "Message" })).toBeEnabled();
    await expect(page.getByRole("status")).toHaveText("Request recorded. CAD execution has not been confirmed.");
    await expect(annotation).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("desktop-send-with-toolbar.png") });
  });
});
