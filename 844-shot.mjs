import { chromium } from "playwright";
const out = "/workspace/qa-batch/844-shots/r3";
const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const cases = [
  { name: "more-ios-available-430", width: 430, ios: true, standalone: false, status: null },
  { name: "more-ios-pwa-safari-430", width: 430, ios: true, standalone: true, status: null },
  { name: "more-loading-375", width: 375, ios: true, standalone: false, status: "LOADING" },
  { name: "more-failed-375", width: 375, ios: true, standalone: false, status: "FAILED" },
  { name: "more-unavailable-desktop-430", width: 430, ios: false, standalone: false, status: null },
];
const browser = await chromium.launch();
for (const c of cases) {
  const ctx = await browser.newContext({ viewport: { width: c.width, height: 860 }, userAgent: c.ios ? iphone : undefined, hasTouch: c.ios });
  await ctx.addInitScript(({ ios, standalone }) => {
    if (ios) {
      Object.defineProperty(Navigator.prototype, "maxTouchPoints", { get: () => 5 });
      const orig = DOMTokenList.prototype.supports;
      DOMTokenList.prototype.supports = function (t) { return t === "ar" ? true : orig.call(this, t); };
    }
    if (standalone) Object.defineProperty(Navigator.prototype, "standalone", { get: () => true });
  }, c);
  const page = await ctx.newPage();
  await page.goto("http://localhost:5844/dev/jarvis-ar?embed=1", { waitUntil: "networkidle" });
  if (c.status) await page.getByLabel(c.status).check();
  await page.getByRole("button", { name: "MORE" }).click();
  await page.waitForTimeout(300);
  const info = await page.evaluate(() => {
    const d = document.querySelector("dialog.jarvis-ar-sheet");
    const cs = d && getComputedStyle(d);
    const h2 = d?.querySelector("h2"); const g = d?.querySelector(".jarvis-ar-grabber"); const cancel = [...(d?.querySelectorAll("button") ?? [])].find((b) => b.textContent === "CANCEL");
    const bd = document.querySelector(".jarvis-ar-backdrop"); const more = [...document.querySelectorAll("button")].find((b) => b.textContent === "MORE");
    const img = d?.querySelector("a img");
    return { bg: cs?.backgroundColor, bottom: d && Math.round(window.innerHeight - d.getBoundingClientRect().bottom), h2Font: h2 && getComputedStyle(h2).font, grabber: g && `${g.getBoundingClientRect().width}x${g.getBoundingClientRect().height}`, cancelH: cancel?.getBoundingClientRect().height, cancelText: cancel && getComputedStyle(cancel).textTransform, backdrop: bd && getComputedStyle(bd).backgroundColor, moreH: more?.getBoundingClientRect().height, posterSrc: img?.getAttribute("src") ?? null, text: d?.innerText.replace(/\n+/g, " | ") };
  });
  console.log(c.name, JSON.stringify(info));
  await page.screenshot({ path: `${out}/${c.name}.png` });
  await ctx.close();
}
await browser.close();
