import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const directory = new URL('.', import.meta.url);
const ensure = (ok, code) => { if (!ok) throw new Error(code); };
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export function render(template, observation, source) {
  const binding = template.source.storageSource;
  ensure(observation.bucket === binding.bucket && observation.name === binding.object, 'source_object_mismatch');
  ensure(typeof observation.generation === 'string' && /^[1-9][0-9]{0,18}$/.test(observation.generation) &&
    BigInt(observation.generation) <= 9223372036854775807n, 'invalid_source_generation');
  ensure(String(observation.size) === String(source.archiveBytes), 'source_size_mismatch');
  ensure(observation.md5Hash === source.archiveMd5Base64, 'source_md5_mismatch');
  const config = structuredClone(template);
  config.source.storageSource.generation = observation.generation;
  return config;
}
export function main(args) {
  ensure(args.length === 1, 'one_raw_object_metadata_file_required');
  const source = JSON.parse(readFileSync(new URL('source-evidence.json', directory)));
  ensure(sha256(readFileSync(new URL('worker-source.tar.gz', directory))) === source.archiveSha256, 'local_archive_changed');
  ensure(sha256(readFileSync(new URL('source-manifest.json', directory))) === source.manifestSha256, 'local_manifest_changed');
  const template = JSON.parse(readFileSync(new URL('cloudbuild.template.json', directory)));
  const observation = JSON.parse(readFileSync(resolve(args[0])));
  const config = render(template, observation, source);
  const bytes = Buffer.from(`${JSON.stringify(config, null, 2)}\n`);
  writeFileSync(new URL('cloudbuild.rendered.json', directory), bytes, { flag: 'wx' });
  process.stdout.write(`${JSON.stringify({ renderedConfigSha256: sha256(bytes),
    sourceGeneration: config.source.storageSource.generation })}\n`);
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) main(process.argv.slice(2));
