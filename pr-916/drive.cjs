const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.tracing.start({ screenshots: true, snapshots: true });
  const p = await ctx.newPage(); const errs = [];
  p.on('pageerror', e => errs.push(String(e.message).slice(0,200)));
  const r = await p.goto('http://127.0.0.1:4174/', { waitUntil: 'networkidle' });
  await p.screenshot({ path: '/tmp/proof916/app-home.png', fullPage: true });
  console.log(JSON.stringify({ status: r.status(), url: p.url(), title: await p.title(), h: (await p.locator('h1,h2').allInnerTexts()).slice(0,3), pageErrors: errs }));
  await ctx.tracing.stop({ path: '/tmp/proof916/trace.zip' }); await b.close();
})();
