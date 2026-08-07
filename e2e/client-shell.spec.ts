import type { Locator, Page } from "@playwright/test";
import { test, expect } from "./test";

const CLIENT_ROUTES = [
  "/parts?fixture=client-quoted&debug=1",
  "/quotes?fixture=client-quoted&debug=1",
  "/search?fixture=client-quoted&debug=1",
  "/parts/fx-job-quoted-a?fixture=client-quoted&debug=1",
  "/quotes/Z5QF44?fixture=client-published&debug=1",
] as const;

async function expectNoDocumentOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    windowScrollY: window.scrollY,
  }));

  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
  expect(dimensions.windowScrollY).toBe(0);
}

async function expectOverlayOwnsItsCenter(page: Page, overlay: Locator) {
  const ownsCenter = await overlay.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const topElement = document.elementFromPoint(
      bounds.left + bounds.width / 2,
      bounds.top + bounds.height / 2,
    );
    return topElement === element || element.contains(topElement);
  });

  expect(ownsCenter).toBe(true);
}

async function expectTooltipAboveWorkspace(page: Page, tooltip: Locator) {
  const geometry = await tooltip.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    let current: Element | null = element;
    let maximumZIndex = 0;

    while (current) {
      const zIndex = Number.parseInt(getComputedStyle(current).zIndex, 10);
      if (Number.isFinite(zIndex)) {
        maximumZIndex = Math.max(maximumZIndex, zIndex);
      }
      current = current.parentElement;
    }

    return {
      bottom: bounds.bottom,
      left: bounds.left,
      right: bounds.right,
      top: bounds.top,
      zIndex: maximumZIndex,
    };
  });

  expect(geometry.zIndex).toBeGreaterThan(40);
  expect(geometry.left).toBeGreaterThanOrEqual(0);
  expect(geometry.top).toBeGreaterThanOrEqual(0);
  expect(geometry.right).toBeLessThanOrEqual(await page.evaluate(() => window.innerWidth));
  expect(geometry.bottom).toBeLessThanOrEqual(await page.evaluate(() => window.innerHeight));
}

test.describe("authenticated client shell contract", () => {
  test("keeps one application frame across every launch client route", async ({ page }) => {
    await page.setViewportSize({ width: 1512, height: 751 });

    for (const route of CLIENT_ROUTES) {
      await page.goto(route);
      await expect(page.locator("[data-client-shell]")).toBeVisible();
      await expect(page.getByRole("banner")).toHaveCount(1);
      await expect(page.locator('[data-workspace-scroll="primary"]')).toHaveCount(1);
      await expect(page.getByRole("navigation", { name: "Primary" })).toHaveCount(1);
      await expectNoDocumentOverflow(page);
    }
  });

  test("exits fixture mode without leaving fixture controls over the live app", async ({ page }) => {
    await page.setViewportSize({ width: 1512, height: 751 });
    await page.goto("/parts/fx-job-quoted-a?fixture=client-quoted&debug=1");

    const fixturePanel = page.locator("[data-fixture-panel]");
    await expect(fixturePanel).toBeVisible();
    await expect(fixturePanel).toHaveCSS("position", "static");

    await page.getByRole("button", { name: "Exit" }).click();

    await expect(page).toHaveURL(/\/?\?auth=signin$/);
    await expect(fixturePanel).toHaveCount(0);
  });

  test("collapses without remounting or moving navigation icons and keeps overlays above content", async ({ page }) => {
    await page.setViewportSize({ width: 1512, height: 751 });
    await page.goto("/parts?fixture=client-quoted&debug=1");

    const iconSelectors = ["Parts", "Quotes", "Search"].map(
      (label) => `svg[data-navigation-icon="${label}"]`,
    );
    const iconHandles = await Promise.all(
      iconSelectors.map((selector) => page.locator(selector).elementHandle()),
    );
    const before = await Promise.all(
      iconSelectors.map((selector) => page.locator(selector).boundingBox()),
    );

    await page.getByRole("button", { name: "Close sidebar" }).click();
    await expect(page.getByRole("complementary")).toHaveCSS("width", "52px");

    const after = await Promise.all(
      iconSelectors.map((selector) => page.locator(selector).boundingBox()),
    );

    for (const [index, handle] of iconHandles.entries()) {
      expect(handle).not.toBeNull();
      expect(before[index]).not.toBeNull();
      expect(after[index]).not.toBeNull();
      expect(after[index]!.x).toBeCloseTo(before[index]!.x, 1);
      expect(after[index]!.y).toBeCloseTo(before[index]!.y, 1);
      const retained = await handle!.evaluate(
        (element, selector) => element === document.querySelector(selector),
        iconSelectors[index],
      );
      expect(retained).toBe(true);
    }

    await page.getByRole("link", { name: "Quotes" }).hover();
    const tooltip = page.getByRole("tooltip", { name: "Quotes" });
    await expect(tooltip).toBeVisible();
    await expectTooltipAboveWorkspace(page, tooltip);

    await page.getByRole("button", { name: /open account menu/i }).click();
    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible();
    await expectOverlayOwnsItsCenter(page, menu);
  });

  test("gives the workspace and inspector independent desktop geometry", async ({ page }) => {
    await page.setViewportSize({ width: 1512, height: 751 });
    await page.goto("/parts/fx-job-quoted-a?fixture=client-quoted&debug=1");

    const workspace = page.locator('[data-workspace-scroll="primary"]');
    const inspector = page.locator('[data-workspace-inspector="desktop"]');
    await expect(inspector).toBeVisible();
    await expect(inspector).toHaveCSS("width", "336px");

    const workspaceScrollTop = await workspace.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      return element.scrollTop;
    });

    expect(workspaceScrollTop).toBeGreaterThan(0);
    await expect(page.getByRole("banner")).toHaveCSS("height", "56px");
    await expectNoDocumentOverflow(page);
  });

  test("uses sheets at tablet and phone widths without horizontal overflow", async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 786 });
    await page.goto("/parts/fx-job-quoted-a?fixture=client-quoted&debug=1");

    await expect(page.locator('[data-workspace-inspector="desktop"]')).toBeHidden();
    await page.getByRole("button", { name: "Open inspector" }).click();
    await expect(page.getByRole("dialog")).toHaveCSS("width", "336px");
    await expectNoDocumentOverflow(page);

    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Open inspector" })).toBeFocused();
    await page.getByRole("button", { name: "Open inspector" }).click();
    await page.setViewportSize({ width: 1512, height: 786 });
    await expect(page.locator('[data-workspace-inspector="desktop"]')).toBeVisible();
    await page.setViewportSize({ width: 768, height: 786 });
    await expect(page.getByRole("dialog")).toHaveCount(0);

    await page.setViewportSize({ width: 390, height: 786 });
    await page.goto("/parts?fixture=client-quoted&debug=1");

    await expect(page.getByRole("complementary")).toBeHidden();
    const navigationTrigger = page.getByRole("button", { name: "Open navigation" });
    await navigationTrigger.click();
    await expect(page.getByRole("dialog")).toHaveCSS("width", "224px");
    await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
    await expectNoDocumentOverflow(page);

    await page.keyboard.press("Escape");
    await expect(navigationTrigger).toBeFocused();
    await navigationTrigger.click();
    await page.setViewportSize({ width: 768, height: 786 });
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 786 });
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });
});
