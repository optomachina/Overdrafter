import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
it('T6 model viewer is dynamically imported only from the lazy loader', () => {
  const root = path.resolve(import.meta.dirname, '../../..');
  function files(dir: string): string[] { return readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(path.join(dir, e.name)) : /\.[tj]sx?$/.test(e.name) && !e.name.includes('.test.') ? [path.join(dir, e.name)] : []); }
  const imports = files(root).filter(f => readFileSync(f, 'utf8').includes('@google/model-viewer'));
  expect(imports).toEqual([path.join(import.meta.dirname, 'model-loader.ts')]);
  expect(readFileSync(imports[0], 'utf8')).toContain("import('@google/model-viewer')");
  expect(readFileSync(imports[0], 'utf8')).not.toMatch(/from\s+['"]@google\/model-viewer/);
});
