// @vitest-environment node
import path from 'node:path';
import { build, loadConfigFromFile, type Rollup } from 'vite';
import { expect, it } from 'vitest';

// Vite inlines every file under 4 KiB as a data: URL, and every preview fixture is that small. The thread rejects
// data: artifact URLs, so an inlined fixture silently disappears from a built preview, along with OPEN 3D VIEW.
// This builds the real preview source with the real vite.config.ts build options and checks the output.
const root = path.resolve(import.meta.dirname, '../../../..');
const previewSource = path.join(import.meta.dirname, 'preview-source.ts');
const entry = '\0preview-entry';

it('emits every preview fixture as its own file in a build instead of a data: URL', async () => {
  const loaded = await loadConfigFromFile({ command: 'build', mode: 'production' }, path.join(root, 'vite.config.ts'), root, 'silent');
  const result = await build({
    root,
    configFile: false,
    logLevel: 'silent',
    publicDir: false,
    plugins: [{
      name: 'preview-entry',
      resolveId: id => (id === entry ? id : undefined),
      load: id => (id === entry ? `import { createPreview } from ${JSON.stringify(previewSource)}; globalThis.createPreview = createPreview;` : undefined),
    }],
    build: { write: false, minify: false, assetsInlineLimit: loaded?.config.build?.assetsInlineLimit, rollupOptions: { input: entry } },
  });
  const { output } = (Array.isArray(result) ? result[0] : result) as Rollup.RollupOutput;
  const code = output.map(o => (o.type === 'chunk' ? o.code : '')).join('\n');
  const files = output.filter(o => o.type === 'asset').map(o => o.fileName);

  expect(code).not.toMatch(/data:[\w/+.-]+;base64,/);
  expect(files.filter(f => f.endsWith('.png'))).toHaveLength(2);
  expect(files.filter(f => f.endsWith('.glb'))).toHaveLength(1);
  // The STEP ships as raw text turned into a blob: URL, because verify-public-assets forbids .step files in dist.
  expect(files.filter(f => f.endsWith('.step'))).toHaveLength(0);
  expect(code).toContain('SYNTHETIC PREVIEW ONLY');
  for (const file of files) expect(code).toContain(`/${file}`);
}, 60_000);
