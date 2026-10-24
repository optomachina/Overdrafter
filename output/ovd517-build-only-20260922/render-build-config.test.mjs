import test from 'node:test';
import assert from 'node:assert/strict';
import { render } from './render-build-config.mjs';
const template = { source: { storageSource: { bucket: 'bucket', object: 'object', generation: 'unbound' } }, steps: [{ args: ['build'] }] };
const source = { archiveBytes: 3, archiveMd5Base64: 'test-md5' };
const observation = { bucket: 'bucket', name: 'object', generation: '1787976891769628', size: '3', md5Hash: 'test-md5' };
test('binds only a lossless generation and retains immutable input', () => {
  const config = render(template, observation, source);
  assert.equal(config.source.storageSource.generation, observation.generation);
  assert.equal(template.source.storageSource.generation, 'unbound');
  assert.deepEqual(config.steps, template.steps);
});
for (const [field, value] of [['bucket', 'foreign'], ['name', 'foreign'], ['generation', 1787976891769628], ['generation', '0'], ['generation', '9223372036854775808'], ['generation', '1\n'], ['size', '4'], ['md5Hash', 'wrong']]) {
  test(`rejects ${field}=${JSON.stringify(value)}`, () => assert.throws(() => render(template, { ...observation, [field]: value }, source)));
}
