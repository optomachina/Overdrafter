import type { Locator, Page, TestInfo } from "@playwright/test";
import { test, expect } from "../test";

// Real seeded stack, same client/part/package as package-selection-state.
// Creates the seeded package selection when absent; request metadata comes from the seed.
const PART_ROUTE = "/parts/00000000-0000-4000-8000-000000000103/review";
const PACKAGE_ROUTE = "/client/packages/00000000-0000-4000-8000-000000000900";

async function measureSurface(page: Page, targets: Locator, name: string, testInfo: TestInfo) {
  expect(await targets.count(), `${name}: expected rendered text targets`).toBeGreaterThan(0);
  const measurements = [];
  for (const target of await targets.all()) {
    await expect(target).toBeVisible();
    await target.scrollIntoViewIfNeeded();
    const handle = await target.elementHandle();
    if (!handle) throw new Error(`${name}: target detached`);
    try {
      measurements.push(...await page.evaluate((root) => {
        type Color = [number, number, number, number];
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 1;
        const context = canvas.getContext("2d", { willReadFrequently: true })!;
        const parse = (value: string): Color => {
          const match = value.match(/^rgba?\(([^)]+)\)$/);
          if (!match) {
            // Dark theme tokens use OKLCH; convert through the browser's sRGB canvas.
            if (!CSS.supports("color", value)) throw new Error(`Unsupported computed color: ${value}`);
            context.clearRect(0, 0, 1, 1);
            context.fillStyle = value;
            context.fillRect(0, 0, 1, 1);
            const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
            return [r, g, b, a / 255];
          }
          const channels = match[1].split(/[,\s/]+/).map(Number);
          return [channels[0], channels[1], channels[2], channels[3] ?? 1];
        };
        const over = (front: Color, back: Color): Color => {
          const alpha = front[3] + back[3] * (1 - front[3]);
          if (!alpha) return [0, 0, 0, 0];
          return [0, 1, 2].map((i) =>
            (front[i] * front[3] + back[i] * back[3] * (1 - front[3])) / alpha,
          ).concat(alpha) as Color;
        };
        const luminance = (color: Color) => {
          const linear = color.slice(0, 3).map((channel) => {
            const s = channel / 255;
            return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
          });
          return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
        };
        const results = [];
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const node = walker.currentNode;
          const element = node.parentElement;
          const text = node.textContent?.trim();
          if (!element || !text || element.closest('svg, [aria-hidden="true"], [role="img"]')) continue;
          const style = getComputedStyle(element);
          const range = document.createRange();
          range.selectNodeContents(node);
          if (!range.getBoundingClientRect().width || style.visibility !== "visible") continue;
          let background: Color = [0, 0, 0, 0];
          let ancestor: Element | null = element;
          while (ancestor) {
            const ancestorStyle = getComputedStyle(ancestor);
            // Fail closed if the simple background model cannot describe the paint.
            if (ancestorStyle.backgroundImage !== "none" || Number(ancestorStyle.opacity) !== 1) {
              throw new Error(`Unsupported image/opacity behind ${text}`);
            }
            if (background[3] < 1) {
              background = over(background, parse(ancestorStyle.backgroundColor));
            }
            ancestor = ancestor.parentElement;
          }
          // Browser canvas is white when no ancestor supplies an opaque page color.
          background = over(background, [255, 255, 255, 1]);
          const foreground = over(parse(style.color), background);
          const a = luminance(foreground);
          const b = luminance(background);
          results.push({ text, color: style.color, background, ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) });
        }
        return results;
      }, handle));
    } finally {
      await handle.dispose();
    }
  }
  await testInfo.attach(name, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
  expect(measurements.length, `${name}: no visible text measured`).toBeGreaterThan(0);
  const report = measurements.map((m) =>
    `${JSON.stringify(m.text)}: ${m.ratio.toFixed(3)}:1; color=${m.color}; effective background=rgba(${m.background.join(", ")})`,
  ).join("\n");
  await testInfo.attach(`${name}-measurements`, { body: report, contentType: "text/plain" });
  expect.soft(measurements.every((m) => m.ratio >= 4.5), `${name}: WCAG AA requires >= 4.5:1\n${report}`).toBe(true);
}

test.describe("OVD-1032 both-theme rendered contrast", () => {
  test.use({ storageState: "playwright/.auth/client.json", viewport: { width: 1280, height: 900 } });

  test("keeps review, handoff, package and notification text readable in both themes", async ({ page }, testInfo) => {
    // Two themes × five pages, each waiting up to 30 s for data; the 30 s default timed out on CI.
    test.setTimeout(120_000);
    for (const theme of ["light", "dark"] as const) {
      await page.goto(PART_ROUTE);
      await page.evaluate((value) => localStorage.setItem("theme", value), theme);
      await page.reload();
      await expect(page.locator("html")).toHaveClass(new RegExp(`\\b${theme}\\b`));
      const manufacturing = page.getByText("Manufacturing quote", { exact: true });
      await expect(manufacturing).toBeVisible({ timeout: 30_000 });
      const quantity = page.getByText(/^Quote qty /);
      const needBy = page.getByText(/^Need by /);
      await expect(quantity).toBeVisible();
      await expect(needBy).toBeVisible();
      await measureSurface(page, manufacturing.or(quantity).or(needBy), `${theme}-part-review-header-chips`, testInfo);

      const handoff = page.locator("section").filter({ has: page.getByRole("heading", { name: "Capture the details needed for manual follow-up" }) });
      const pill = handoff.getByText(/^(\d+ details still needed|Ready for follow-up)$/);
      const stillNeeded = handoff.locator("div").filter({ has: page.getByText("Still needed", { exact: true }) }).last();
      await expect(pill).toBeVisible();
      // Default handoff state has missing details; absence must not silently skip coverage.
      await expect(stillNeeded.getByRole("listitem").first()).toBeVisible();
      await measureSurface(page, pill.or(stillNeeded), `${theme}-handoff-pill-and-still-needed`, testInfo);

      await page.goto(PACKAGE_ROUTE);
      await expect(page.locator("html")).toHaveClass(new RegExp(`\\b${theme}\\b`));
      const receiptHeading = page.getByRole("heading", { name: "Selection received", exact: true });
      const lowest = page.locator(".border").filter({ has: page.getByRole("heading", { name: "Lowest cost", exact: true }) }).last();
      await expect(lowest).toBeVisible({ timeout: 30_000 });
      if (await receiptHeading.count() === 0) {
        // The receipt exists only after a selection. Make the same seeded selection that
        // package-selection-state.spec.ts makes (no provider or order action), so this
        // surface is measured whatever order the journeys run in.
        await lowest.getByRole("button", { name: /Select (this|another) option/ }).click();
      }
      const receipt = page.locator(".border").filter({ has: receiptHeading }).last();
      await expect(receipt).toBeVisible({ timeout: 30_000 });
      await measureSurface(page, receipt, `${theme}-package-selection-received`, testInfo);
      const insetColors = await lowest.evaluate((card) => {
        const probe = document.createElement("div");
        probe.style.backgroundColor = "var(--muted)";
        document.body.appendChild(probe);
        try {
          return { card: getComputedStyle(card).backgroundColor, muted: getComputedStyle(probe).backgroundColor };
        } finally {
          probe.remove();
        }
      });
      expect(insetColors.card, `${theme}: package option card must use the --muted inset surface`).toBe(insetColors.muted);
      const lowestMuted = lowest.locator(".text-muted-foreground");
      await expect(lowestMuted.first()).toBeVisible();
      await measureSurface(page, lowestMuted, `${theme}-package-option-muted-on-inset`, testInfo);
      const stats = page.locator("section").filter({ has: page.getByText("Best Price", { exact: true }) });
      await expect(stats.getByText("Selected", { exact: true })).toBeVisible();
      await measureSurface(page, stats, `${theme}-package-stat-strip`, testInfo);

      await page.goto("/quotes");
      await page.getByRole("button", { name: /open account menu/i }).click();
      await page.getByRole("menuitem", { name: /^Notifications/ }).click();
      const notifications = page.getByRole("dialog", { name: "Notifications", exact: true });
      await expect(notifications).toBeVisible();
      const badges = notifications.locator('span[class*="text-[11px]"]');
      await expect(notifications.getByText(/^\d+ in center$/)).toBeVisible();
      await measureSurface(page, badges, `${theme}-account-notification-badges`, testInfo);
    }
  });
});
