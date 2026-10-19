// F. Smoke tests for the public prototype pages (public/v2 .. v9 and public/variants/) through a static loopback server.
import { test, expect } from "../helpers/fixtures.mjs";
import { PAGE_IDS, TAGLINE_LINES, BANNED, SIZES, MISSION_SENTENCE, h1Lines, collectText, overflow } from "../helpers/pages.mjs";

const settle = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

for (const id of PAGE_IDS) {
  test.describe(`${id}`, { tag: ["@pages"] }, () => {
    test(`${id} loads with the approved tagline, a title, and only loopback requests`, async ({ page, site, guard }) => {
      await page.goto(`${site.url}/${id}/`);
      await expect(page.locator("h1")).toBeVisible();
      expect(await page.evaluate(h1Lines)).toEqual(TAGLINE_LINES);
      expect(await page.title()).toMatch(/OverDrafter/);
      // "10%" appears only inside the mission sentence.
      const text = await page.evaluate(collectText);
      const pct = [...text.body.matchAll(/10%/g)];
      if (pct.length) expect(text.body, `${id} 10%`).toContain(MISSION_SENTENCE);
      expect(pct.length, `${id} 10% count`).toBeLessThanOrEqual(1);
      expect(guard.requests.length).toBeGreaterThan(0);
      expect(guard.requests.every((r) => r.includes("//127.0.0.1:"))).toBe(true);
    });

    test(`${id} wording follows the public rules (no dates, quarters, timing words or third-party names)`, async ({ page, site }) => {
      await page.goto(`${site.url}/${id}/`);
      await expect(page.locator("h1")).toBeVisible();
      const text = await page.evaluate(collectText);
      for (const [where, s] of [["title", text.title], ["body", text.body], ...text.attrs.map((a) => ["attribute", a])]) {
        const hit = s.match(BANNED);
        expect(hit ? `banned wording "${hit[0]}" in: ...${s.slice(Math.max(0, hit.index - 70), hit.index + 70)}...` : null, `${id} ${where}`).toBeNull();
      }
    });

    for (const scheme of ["light", "dark"]) {
      test(`${id} has no horizontal scroll at 390, 768 and 1024 (${scheme})`, async ({ page, site }) => {
        await page.emulateMedia({ colorScheme: scheme });
        await page.goto(`${site.url}/${id}/`);
        await expect(page.locator("h1")).toBeVisible();
        for (const size of SIZES) {
          await page.setViewportSize({ width: size.width, height: size.height });
          await settle(page);
          const o = await page.evaluate(overflow);
          expect(o.scrollWidth, `${id} ${scheme} ${size.name}: document scrollWidth vs ${o.clientWidth}`).toBeLessThanOrEqual(o.clientWidth);
          expect(o.bodyScrollWidth, `${id} ${scheme} ${size.name}: body scrollWidth`).toBeLessThanOrEqual(o.innerWidth);
        }
        // Where the page has its own theme toggle, the other theme must not overflow either.
        const toggle = page.locator("#theme");
        if (await toggle.count()) {
          for (const size of SIZES) {
            await page.setViewportSize({ width: size.width, height: size.height });
            await toggle.click();
            await settle(page);
            const o = await page.evaluate(overflow);
            expect(o.scrollWidth, `${id} toggled theme ${size.name}`).toBeLessThanOrEqual(o.clientWidth);
          }
        }
      });
    }
  });
}

test.describe("variants", { tag: ["@pages"] }, () => {
  test("the variants index lists every prototype and each link resolves", async ({ page, site, request }) => {
    await page.goto(`${site.url}/variants/`);
    await expect(page).toHaveTitle("OverDrafter homepage variants");
    await expect(page.locator("h1")).toHaveText("Homepage variants");
    const rows = await page.locator("ul a.row").evaluateAll((as) => as.filter((a) => a.querySelector(".tag")).map((a) => ({ tag: a.querySelector(".tag").textContent.trim(), href: a.getAttribute("href") })));
    expect(rows.map((r) => r.tag)).toEqual(["v9", "v8", "v7", "v6", "v2", "v4", "v3", "v5", "main"]);
    for (const row of rows.filter((r) => r.tag !== "main")) {
      const res = await request.get(new URL(row.href, `${site.url}/variants/`).toString());
      expect(res.status(), row.href).toBe(200);
    }
    // Every other link on the page too (the rail view link, the tagline options).
    const links = await page.locator("a[href]").evaluateAll((as) => [...new Set(as.map((a) => a.getAttribute("href")))]);
    for (const href of links.filter((h) => h !== "/")) {
      const res = await request.get(new URL(href, `${site.url}/variants/`).toString());
      expect(res.status(), href).toBe(200);
    }
    // "main" is the React app at "/", which this prototype server does not serve (documented limit).
    expect(rows.find((r) => r.tag === "main").href).toBe("/");
  });

  test("the tagline lockup page shows the approved tagline in all four lockups", async ({ page, site }) => {
    await page.goto(`${site.url}/variants/tagline.html`);
    await expect(page).toHaveTitle("OverDrafter tagline lockups");
    const lockups = await page.locator("h2.lockup").evaluateAll((hs) => hs.map((h) => h.innerText.split("\n").map((s) => s.trim()).filter(Boolean)));
    expect(lockups).toHaveLength(4);
    for (const lines of lockups) expect([lines[0].replace(/:$/, ""), lines[1], lines[2]]).toEqual(TAGLINE_LINES);
    const text = await page.evaluate(collectText);
    expect(`${text.title} ${text.body}`).not.toMatch(BANNED);
  });

  for (const path of ["/variants/", "/variants/tagline.html"]) {
    test(`${path} has no horizontal scroll at 390, 768 and 1024 and no banned wording`, async ({ page, site }) => {
      await page.goto(`${site.url}${path}`);
      for (const size of SIZES) {
        await page.setViewportSize({ width: size.width, height: size.height });
        await settle(page);
        const o = await page.evaluate(overflow);
        expect(o.scrollWidth, `${path} ${size.name}`).toBeLessThanOrEqual(o.clientWidth);
      }
      const text = await page.evaluate(collectText);
      expect(`${text.title} ${text.body} ${text.attrs.join(" ")}`).not.toMatch(BANNED);
    });
  }
});
