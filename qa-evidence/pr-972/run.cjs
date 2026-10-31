const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.tracing.start({ screenshots: true, snapshots: true });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(String(e.message)));
  await p.goto('http://127.0.0.1:4180/?auth=signin&debug=1', { waitUntil: 'networkidle' });
  await p.locator('#auth-email').waitFor({ state: 'visible', timeout: 20000 });
  const login = await p.locator('form').getByRole('button', { name: /^Log in$/ }).isVisible();
  await p.screenshot({ path: '/tmp/proof972/01-landing-auth-dialog.png' });
  await p.goto('http://127.0.0.1:4180/', { waitUntil: 'networkidle' });
  await p.screenshot({ path: '/tmp/proof972/02-landing.png' });
  await ctx.tracing.stop({ path: '/tmp/proof972/trace.zip' });
  console.log(JSON.stringify({ authEmailVisible: true, loginButtonVisible: login, pageErrors: errors.length, title: await p.title() }));
  await b.close();
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
