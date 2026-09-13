import { test, expect } from "./test";

test.use({ video: "on" });

const conversationId = "10000000-0000-4000-8000-000000000001";
const snapshotId = "10000000-0000-4000-8000-000000000002";

test.describe("annotation launcher keyboard access", { tag: "@fixture" }, () => {
  for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 900 }]) {
    for (const key of ["Enter", "Space"]) {
      test(`${key} activates once at ${viewport.width}px`, async ({ page }, testInfo) => {
        await page.setViewportSize(viewport);
        let requests = 0;
        await page.route("http://127.0.0.1:9/**", async (route) => {
          const path = new URL(route.request().url()).pathname;
          if (path.endsWith("/engineering_conversations")) return route.fulfill({ json: {
            id: conversationId, organization_id: conversationId, project_id: conversationId,
            owner_user_id: "fixture-user-client", revision: 2, head_snapshot_id: snapshotId,
          } });
          if (path.endsWith("/engineering_messages") || path.endsWith("/engineering_tasks")) return route.fulfill({ json: [] });
          if (path.endsWith("/rpc/api_submit_engineering_message")) {
            requests += 1;
            return route.fulfill({ json: { conversationId, inputSnapshotId: snapshotId,
              messageId: snapshotId, requestId: conversationId, revision: 3 } });
          }
          return route.abort();
        });
        await page.addInitScript(() => {
          document.addEventListener("click", (event) => {
            if (event.target instanceof Element && event.target.closest('[role="button"][title="Start feedback mode"]')) {
              document.documentElement.dataset.annotationClicks = String(Number(document.documentElement.dataset.annotationClicks ?? 0) + 1);
            }
          }, true);
        });
        await page.goto(`/engineering?conversation=${conversationId}&fixture=client-quoted`);
        await expect(page.getByRole("status")).toContainText("Conversation loaded");
        const launcher = page.getByTitle("Start feedback mode", { exact: true });
        // Reach the portal using normal sequential keyboard navigation.
        for (let i = 0; i < 20 && !await launcher.evaluate((element) => element === document.activeElement); i += 1) {
          await page.keyboard.press("Tab");
        }
        await expect(launcher).toBeFocused();
        const scrollBefore = await page.evaluate(() => ({ x: scrollX, y: scrollY }));
        await page.keyboard.down(key);
        if (key === "Space") await expect(launcher).toBeVisible();
        await page.keyboard.down(key); // Repeat must not activate a second time.
        await page.keyboard.up(key);
        await expect(launcher).toHaveCount(0, { timeout: 1500 });
        await expect(page.locator("html")).toHaveAttribute("data-annotation-clicks", "1");
        expect(await page.evaluate(() => ({ x: scrollX, y: scrollY }))).toEqual(scrollBefore);
        // Capture the expanded toolbar after its width transition, not the first animation frame.
        await expect.poll(async () => (await page.locator("[data-agentation-toolbar] > div").first().boundingBox())?.width ?? 0).toBeGreaterThan(250);
        await page.locator("[data-agentation-toolbar]").evaluate(async (element) => {
          const transitions = element.getAnimations({ subtree: true }).filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity);
          await Promise.all(transitions.map((animation) => animation.finished.catch(() => {})));
        });
        await page.screenshot({ path: testInfo.outputPath("keyboard-activated.png") });
        await page.keyboard.press("Escape");
        await expect(launcher).toBeVisible();
        await launcher.click();
        await expect(launcher).toHaveCount(0);
        await expect(page.locator("html")).toHaveAttribute("data-annotation-clicks", "2");
        await page.keyboard.press("Escape");
        const composer = page.getByRole("textbox", { name: "Message", exact: true });
        await composer.fill("Review");
        await composer.press("Space");
        await composer.press("Enter");
        await composer.press("x");
        await expect(composer).toHaveValue("Review \nx");
        await expect(launcher).toBeVisible();
        await expect(page.locator("html")).toHaveAttribute("data-annotation-clicks", "2");
        await page.getByRole("button", { name: "Send message", exact: true }).click({ timeout: 3000 });
        await expect(page.getByRole("status")).toHaveText("Request recorded. CAD execution has not been confirmed.");
        expect(requests).toBe(1);
        await page.screenshot({ path: testInfo.outputPath("ordinary-send.png") });
      });
    }
  }
});
