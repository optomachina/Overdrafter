import { chromium } from "playwright";
const out = "/workspace/qa-batch/844-shots/oct17";
const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const states = [
  { name: "more-ios-available", ios: true, standalone: false, status: null },
  { name: "more-ios-pwa-safari", ios: true, standalone: true, status: null },
  { name: "more-loading", ios: true, standalone: false, status: "LOADING" },
  { name: "more-failed", ios: true, standalone: false, status: "FAILED" },
  { name: "more-unavailable-desktop", ios: false, standalone: false, status: null },
  { name: "card", ios: true, standalone: false, status: null, noOpen: true },
];
const browser = await chromium.launch();
async function ctxFor(c, width) {
  const ctx = await browser.newContext({ viewport: { width, height: 860 }, userAgent: c.ios ? iphone : undefined, hasTouch: c.ios });
  await ctx.addInitScript(({ ios, standalone }) => {
    if (ios) {
      Object.defineProperty(Navigator.prototype, "maxTouchPoints", { get: () => 5 });
      const orig = DOMTokenList.prototype.supports;
      DOMTokenList.prototype.supports = function (t) { return t === "ar" ? true : orig.call(this, t); };
    }
    if (standalone) Object.defineProperty(Navigator.prototype, "standalone", { get: () => true });
  }, c);
  return ctx;
}
for (const width of [375, 430]) for (const c of states) {
  const ctx = await ctxFor(c, width); const page = await ctx.newPage();
  await page.goto("http://localhost:5844/dev/jarvis-ar?embed=1", { waitUntil: "networkidle" });
  if (c.status) await page.getByLabel(c.status).check();
  if (!c.noOpen) { await page.getByRole("button", { name: "MORE" }).click(); await page.waitForTimeout(300); }
  const info = await page.evaluate(() => {
    const d = document.querySelector("dialog.jarvis-ar-sheet"); const cs = d && getComputedStyle(d);
    const h2 = d?.querySelector("h2"); const g = d?.querySelector(".jarvis-ar-grabber");
    const cancel = [...(d?.querySelectorAll("button") ?? [])].find((b) => b.textContent === "CANCEL");
    const bd = document.querySelector(".jarvis-ar-backdrop"); const more = [...document.querySelectorAll("button")].find((b) => b.textContent === "MORE");
    const anchors = [...(d?.querySelectorAll("a") ?? [])].map((a) => ({ rel: a.getAttribute("rel"), href: (a.getAttribute("href") || "").slice(0, 60), img: a.querySelector("img")?.getAttribute("src") ?? null }));
    return { bg: cs?.backgroundColor, bottom: d && Math.round(window.innerHeight - d.getBoundingClientRect().bottom), h2Font: h2 && getComputedStyle(h2).font, grabber: g && `${g.getBoundingClientRect().width}x${g.getBoundingClientRect().height}`, cancelH: cancel?.getBoundingClientRect().height, backdrop: bd && getComputedStyle(bd).backgroundColor, moreH: more?.getBoundingClientRect().height, anchors, text: d?.innerText.replace(/\n+/g, " | ") ?? null, placeholderSvg: document.documentElement.innerHTML.includes("placeholder.svg") };
  });
  console.log(`${c.name}-${width}`, JSON.stringify(info));
  await page.screenshot({ path: `${out}/${c.name}-${width}.png` });
  await ctx.close();
}
// Real keyboard probe (browser Tab order, not synthetic events)
{
  const c = states[3]; const ctx = await ctxFor(c, 430); const page = await ctx.newPage();
  await page.goto("http://localhost:5844/dev/jarvis-ar?embed=1", { waitUntil: "networkidle" });
  await page.getByLabel("FAILED").check();
  const more = page.getByRole("button", { name: "MORE" }); await more.focus(); await page.keyboard.press("Enter"); await page.waitForTimeout(200);
  const where = () => page.evaluate(() => { const a = document.activeElement; const d = document.querySelector("dialog.jarvis-ar-sheet"); return { tag: a?.tagName, text: (a?.textContent || "").trim().slice(0, 30), inDialog: !!d && d.contains(a), backdrop: a?.classList?.contains("jarvis-ar-backdrop") ?? false }; });
  console.log("KB open", JSON.stringify(await where()));
  const seq = [];
  for (let i = 0; i < 6; i++) { await page.keyboard.press("Tab"); seq.push(await where()); }
  for (let i = 0; i < 3; i++) { await page.keyboard.press("Shift+Tab"); seq.push(await where()); }
  console.log("KB tab-seq", JSON.stringify(seq), "allInDialog=" + seq.every((s) => s.inDialog), "anyBackdrop=" + seq.some((s) => s.backdrop));
  const retry = page.getByRole("button", { name: /try again/i }); await retry.focus(); await page.keyboard.press("Enter"); await page.waitForTimeout(200);
  console.log("KB after TRY AGAIN", JSON.stringify(await where()));
  await page.keyboard.press("Tab"); console.log("KB tab after retry", JSON.stringify(await where()));
  await page.keyboard.press("Escape"); await page.waitForTimeout(200);
  console.log("KB after Escape", JSON.stringify(await where()), "dialogOpen=" + (await page.locator("dialog.jarvis-ar-sheet").count()));
  await more.click(); await page.waitForTimeout(200);
  await page.mouse.click(200, 40); await page.waitForTimeout(200);
  console.log("backdrop click: dialogOpen=" + (await page.locator("dialog.jarvis-ar-sheet").count()), JSON.stringify(await where()));
  await ctx.close();
}
await browser.close();
