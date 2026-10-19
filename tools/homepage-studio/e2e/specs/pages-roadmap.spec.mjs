// F (continued). Chapter rail, roadmap wires, cluster keyboard behaviour, v9 prompt bar and Coming soon panel,
// reduced motion, and the CAPABILITIES flip regression, for v7, v8 and v9.
import { test, expect } from "../helpers/fixtures.mjs";
import { MISSION_SENTENCE } from "../helpers/pages.mjs";

const STORY_PAGES = ["v7", "v8", "v9"];
const PLANNED_ARIA = /Planned, not available yet/;

for (const id of STORY_PAGES) {
  test.describe(`${id} story`, { tag: ["@pages"] }, () => {
    test.use({ viewport: { width: 1024, height: 768 } });

    test("every chapter is reachable from the chapter rail", async ({ page, site }) => {
      await page.goto(`${site.url}/${id}/`);
      const dots = page.locator("#rail button.dot");
      const n = await dots.count();
      expect(n).toBeGreaterThanOrEqual(7);
      await expect(page.locator("article.chap")).toHaveCount(n);
      for (let c = 0; c < n; c++) {
        const dot = page.locator(`#rail button.dot[data-c="${c}"]`);
        const title = (await dot.getAttribute("aria-label")).replace(/^Chapter \d+( of \d+)?: /, "");
        await dot.click();
        await expect(dot).toHaveAttribute("aria-current", "step");
        const article = page.locator(`article.chap[data-c="${c}"]`);
        await expect(article).toHaveClass(/is-active/);
        await expect(article.locator("h2").first()).toHaveText(title);
      }
    });

    test("the roadmap lights exactly two live capabilities and leaves every other one unpowered", async ({ page, site }) => {
      await page.goto(`${site.url}/${id}/`);
      const facts = await page.evaluate(() => {
        const caps = typeof CAPABILITIES !== "undefined" ? CAPABILITIES : [];
        const dash = (el) => getComputedStyle(el).strokeDasharray;
        const liveEls = [...document.querySelectorAll(".cap[data-cap][data-status=live]")];
        const plannedStage = [...document.querySelectorAll(".cap[data-cap][data-status=planned]")];
        const chips = [...document.querySelectorAll(".chip[data-cap]")];
        const labelOf = (el) => (el.matches("button") ? el : el.querySelector("button")).getAttribute("aria-label");
        return {
          liveIds: [...new Set(liveEls.map((e) => e.dataset.cap))].sort(),
          liveLabels: [...new Set(liveEls.map((e) => e.querySelector(".st").textContent.trim()))],
          liveHasBlade: liveEls.some((e) => e.querySelector(".stub .blade")),
          liveAria: liveEls.map((e) => labelOf(e)),
          capsLive: caps.filter((c) => c.status === "live").map((c) => c.id).sort(),
          capsPlanned: caps.filter((c) => c.status === "planned").map((c) => c.id),
          plannedStage: plannedStage.map((e) => ({ id: e.dataset.cap, aria: labelOf(e), blade: !!e.querySelector(".stub .blade"), dashed: dash(e.querySelector(".stub path.w")) !== "none", st: e.querySelector(".st").textContent.trim() })),
          chips: chips.map((e) => ({ id: e.dataset.cap, status: e.dataset.status, aria: labelOf(e), blade: !!e.querySelector("svg .bl, svg .blade"), st: e.querySelector(".st").textContent.trim() })),
        };
      });
      expect(facts.liveIds).toEqual(["quotes", "specs"]);
      if (facts.capsLive.length || facts.capsPlanned.length) expect(facts.capsLive).toEqual(["quotes", "specs"]); // v7 keeps CAPABILITIES private
      expect(facts.liveLabels).toEqual(["Live in Founding Beta"]);
      expect(facts.liveHasBlade, "live wires are solid, no gap").toBe(false);
      for (const a of facts.liveAria) expect(a).toMatch(/Live in Founding Beta/);
      // Every planned capability is rendered somewhere, unpowered, with accessible "Planned, not available yet" text.
      const rendered = new Set([...facts.plannedStage.map((p) => p.id), ...facts.chips.map((c) => c.id)]);
      for (const cid of facts.capsPlanned) expect(rendered.has(cid), `${id} renders planned capability ${cid}`).toBe(true);
      expect(facts.plannedStage.length).toBeGreaterThan(0);
      for (const p of facts.plannedStage) {
        expect(p.aria, p.id).toMatch(PLANNED_ARIA);
        expect(p.blade, `${p.id} has the broken (unpowered) wire`).toBe(true);
        expect(p.dashed, `${p.id} wire is dashed`).toBe(true);
        expect(p.st, p.id).toBe(id === "v9" ? "Coming soon" : "Planned · not available yet");
      }
      for (const c of facts.chips) {
        expect(c.status, c.id).toBe("planned");
        expect(c.aria, c.id).toMatch(PLANNED_ARIA);
        expect(c.blade, `${c.id} chip wire`).toBe(true);
        expect(c.st, c.id).toBe(id === "v9" ? "Coming soon" : "Planned · not available yet");
      }
    });

    test("flipping statuses in CAPABILITIES re-renders label, stub and glow", async ({ page, site }) => {
      test.skip(id === "v7", "v7 renders its roadmap once at load and has no re-render hook on CAPABILITIES (v8 and v9 re-render when it changes). Adding one would restructure v7, which is out of scope.");
      await page.goto(`${site.url}/${id}/`);
      const cap = (c) => page.locator(`.cap[data-cap="${c}"]`).first();
      await expect(cap("text2cad")).toHaveAttribute("data-status", "planned");
      await page.evaluate(() => {
        CAPABILITIES.find((c) => c.id === "text2cad").status = "live";
        CAPABILITIES.find((c) => c.id === "specs").status = "planned";
      });
      await expect(cap("text2cad")).toHaveAttribute("data-status", "live");
      await expect(cap("text2cad").locator(".st")).toHaveText("Live in Founding Beta");
      await expect(cap("text2cad").locator(".stub .blade")).toHaveCount(0);
      await expect(cap("text2cad").locator(".stub .pd")).toHaveCount(1); // the powered pulse dot
      await expect(cap("specs")).toHaveAttribute("data-status", "planned");
      await expect(cap("specs").locator(".stub .blade")).toHaveCount(1);
      await expect(cap("specs").locator(".stub .pd")).toHaveCount(0);
      await expect(cap("specs").locator("button.node")).toHaveAttribute("aria-label", PLANNED_ARIA);
      expect(await page.evaluate(() => [...new Set([...document.querySelectorAll(".cap[data-cap][data-status=live]")].map((e) => e.dataset.cap))].sort())).toEqual(["quotes", "text2cad"]);
      // Everything back to planned: no powered node, the logo mark stops glowing.
      await page.evaluate(() => CAPABILITIES.forEach((c) => { c.status = "planned"; }));
      await expect(page.locator(".cap[data-cap][data-status=live]")).toHaveCount(0);
      await expect(page.locator(".mark.glow")).toHaveCount(0);
      await page.evaluate(() => { CAPABILITIES.find((c) => c.id === "quotes").status = "live"; });
      await expect(page.locator(".mark.glow").first()).toBeAttached();
    });
  });
}

for (const id of ["v8", "v9"]) {
  test.describe(`${id} roadmap modes`, { tag: ["@pages"] }, () => {
    test.use({ viewport: { width: 1024, height: 768 } });
    for (const mode of ["clusters", "rail"]) {
      test(`${mode} view: a cluster expands and collapses with Enter and Space (aria-expanded flips)`, async ({ page, site }) => {
        await page.goto(`${site.url}/${id}/${mode === "rail" ? "?roadmap=rail" : ""}`);
        if (mode === "rail") await expect(page.locator("#roadmap")).toBeHidden();
        else await expect(page.locator("#roadmap")).toBeAttached();
        const head = page.locator(".cl-head").first();
        const panelId = await head.getAttribute("aria-controls");
        const chips = page.locator(`#${panelId}`);
        await head.scrollIntoViewIfNeeded();
        await head.focus();
        await expect(head).toHaveAttribute("aria-expanded", "false");
        await expect(chips).toBeHidden();
        for (const key of ["Enter", "Space", "Enter"]) {
          await head.press(key);
          await expect(head).toHaveAttribute("aria-expanded", "true");
          await expect(chips).toBeVisible();
          await head.press(key === "Space" ? "Space" : "Enter");
          await expect(head).toHaveAttribute("aria-expanded", "false");
          await expect(chips).toBeHidden();
        }
        await expect(page.locator("#review button[data-rm]").nth(mode === "rail" ? 1 : 0)).toHaveAttribute("aria-pressed", "true");
      });
    }
  });
}

test.describe("v9 prompt bar", { tag: ["@pages"] }, () => {
  test.use({ viewport: { width: 1024, height: 768 } });

  test("types the example prompt, then the chapter action plays out", async ({ page, site }) => {
    await page.goto(`${site.url}/v9/`);
    const prompts = await page.evaluate(() => PROMPTS.map((p) => ({ chapter: p.chapter, text: p.text })));
    const pt = page.locator(".pwrap .pt").first();
    const caret = page.locator(".pwrap .pcaret").first();
    await expect(pt).toHaveText(prompts.find((p) => p.chapter === 1).text, { timeout: 15_000 }); // chapter 1 is typed on load
    await expect(caret).toBeHidden();
    // Chapter 3: the prompt types first, and only then does the scan action fire and settle.
    await page.locator('#rail button.dot[data-c="2"]').click();
    const first3 = prompts.find((p) => p.chapter === 3).text;
    await expect(pt).toHaveText(first3, { timeout: 15_000 });
    await expect(caret).toBeHidden();
    const scene = () => page.locator("#fig .scene").evaluate((n) => n.innerHTML);
    let last = "";
    let stable = 0;
    await expect.poll(async () => {
      const now = await scene();
      stable = now === last ? stable + 1 : 0;
      last = now;
      return stable >= 3;
    }, { timeout: 15_000, intervals: [250] }).toBe(true);
    await expect(page.locator("#cap")).toContainText("Chapter 3 of 7");
  });
});

test.describe("v9 Coming soon panel", { tag: ["@pages"] }, () => {
  test.use({ viewport: { width: 1024, height: 768 } });
  const triggers = {
    "a roadmap node": (page) => page.locator('.cap[data-cap="text2cad"] button.node').first(),
    "a cluster chip": async (page) => {
      const head = page.locator(".cl-head").first();
      await head.scrollIntoViewIfNeeded();
      await head.click();
      return page.locator(".chip[data-soon]").first();
    },
  };
  for (const [name, getTrigger] of Object.entries(triggers)) {
    test(`opens from ${name}, traps focus, closes on Esc and returns focus`, async ({ page, site, guard }) => {
      await page.goto(`${site.url}/v9/`);
      const trigger = await getTrigger(page);
      await trigger.scrollIntoViewIfNeeded();
      await trigger.click();
      const bk = page.locator("#soonBk");
      await expect(bk).toBeVisible();
      await expect(page.locator("#soon")).toBeFocused();
      await expect(page.locator("#soon")).toHaveAttribute("aria-modal", "true");
      // Focus trap: tabbing more times than there are controls never leaves the dialog; Shift+Tab wraps backwards.
      for (let i = 0; i < 8; i++) {
        await page.keyboard.press("Tab");
        expect(await page.evaluate(() => !!document.activeElement.closest("#soon")), `tab ${i}`).toBe(true);
      }
      for (let i = 0; i < 8; i++) {
        await page.keyboard.press("Shift+Tab");
        expect(await page.evaluate(() => !!document.activeElement.closest("#soon")), `shift+tab ${i}`).toBe(true);
      }
      expect(await page.evaluate(() => document.querySelector("main").inert)).toBe(true); // the page behind is inert
      await page.keyboard.press("Escape");
      await expect(bk).toBeHidden();
      await expect(trigger).toBeFocused();
      expect(await page.evaluate(() => document.querySelector("main").inert)).toBe(false);
      expect(guard.offHost).toEqual([]);
    });
  }

  test("a valid email shows 'Prototype only: nothing was stored.' with zero requests and no storage writes", async ({ page, site, guard }) => {
    await page.goto(`${site.url}/v9/`);
    const node = page.locator('.cap[data-cap="text2cad"] button.node').first();
    await node.scrollIntoViewIfNeeded();
    await node.click();
    await expect(page.locator("#soonBk")).toBeVisible();
    const storage = () => page.evaluate(() => JSON.stringify([{ ...localStorage }, { ...sessionStorage }, document.cookie]));
    const beforeStorage = await storage();
    const beforeRequests = guard.requests.length;
    await page.locator("#soonEmail").fill("not-an-email");
    await page.locator('#soonForm button[type="submit"]').click();
    await expect(page.locator("#soonErr")).toBeVisible();
    await expect(page.locator("#soonMsg")).toBeHidden();
    await page.locator("#soonEmail").fill("name@example.com");
    await page.locator('#soonForm button[type="submit"]').click();
    await expect(page.locator("#soonMsg")).toHaveText("Prototype only: nothing was stored.");
    await expect(page.locator("#soonErr")).toBeHidden();
    expect(guard.requests.length, "no network request on submit").toBe(beforeRequests);
    expect(await storage(), "nothing written to storage or cookies").toBe(beforeStorage);
  });
});

test.describe("reduced motion", { tag: ["@pages"] }, () => {
  test.use({ viewport: { width: 1024, height: 768 } });

  test("v9 shows the static final state: full prompt text at once, no typing, no replay controls", async ({ page, site }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(`${site.url}/v9/`);
    const prompts = await page.evaluate(() => PROMPTS.map((p) => ({ chapter: p.chapter, text: p.text })));
    const statics = page.locator(".pwrap.pstatic");
    await expect(statics).toHaveCount(7);
    for (let c = 1; c <= 7; c++) {
      const bar = statics.nth(c - 1);
      await expect(bar.locator(".pt")).toHaveText(prompts.find((p) => p.chapter === c).text); // immediately, no waiting for a typing animation
      await expect(bar.locator(".pcaret")).toBeHidden();
      await expect(bar.locator(".pfull")).toContainText("Example prompt: ");
    }
    await expect(page.locator("#replay")).toBeHidden();
    expect(await page.evaluate(() => document.getAnimations().filter((a) => a.playState === "running" && a.effect?.getComputedTiming().iterations === Infinity).length)).toBe(0);
    await expect(page.locator(".mtext")).toHaveText(MISSION_SENTENCE);
  });

  // Under reduced motion the page shows the final static state, so no Replay control may be visible (they would be inert).
  for (const id of ["v7", "v8", "v9"]) {
    test(`${id} hides every Replay control under reduced motion`, async ({ page, site }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.goto(`${site.url}/${id}/`);
      await expect(page.locator("h1")).toBeVisible();
      const replayish = page.locator("button", { hasText: /replay/i });
      expect(await replayish.count(), `${id} has Replay controls in the DOM (guards the selector)`).toBeGreaterThan(0);
      await expect(page.locator("[data-replay]:visible, #replay:visible, #replay2:visible")).toHaveCount(0);
      await expect(replayish.locator("visible=true")).toHaveCount(0);
    });
  }

});
