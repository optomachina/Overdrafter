// FUTURE APPROVAL-GATED EXECUTION ONLY. Importing this module runs no Docker commands.
import { readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
export const SOURCE_SHA = '7da20710b25a6a30d0f9ac59e88e00f685defc67';
export const IMAGE_REPO = 'us-west1-docker.pkg.dev/overdrafter-worker-9133/cloud-run-source-deploy/overdrafter-cad-worker';
const DOCKER_HOST = 'unix:///var/run/docker.sock';
function ensure(value, code) { if (!value) throw new Error(code); }
export function validateImage(image) {
  ensure(typeof image === 'string' && image.startsWith(`${IMAGE_REPO}@sha256:`) &&
    image.length === `${IMAGE_REPO}@sha256:`.length + 64 &&
    /^[0-9a-f]{64}$/.test(image.slice(`${IMAGE_REPO}@sha256:`.length)), 'exact_image_digest_required');
  return image;
}
export function validateMetadata(rows, image) {
  ensure(Array.isArray(rows) && rows.length === 1, 'image_metadata_count_mismatch');
  const meta = rows[0];
  ensure(meta.Os === 'linux' && meta.Architecture === 'amd64', 'image_platform_mismatch');
  ensure(meta.RepoDigests?.includes(image), 'local_repo_digest_mismatch');
  ensure(/^sha256:[0-9a-f]{64}$/.test(meta.Id), 'local_image_id_invalid');
  const env = meta.Config?.Env;
  ensure(Array.isArray(env) && env.every(item => typeof item === 'string'), 'image_environment_invalid');
  ensure(env.filter(item => item.startsWith('WORKER_BUILD_VERSION=')).length === 1 &&
    env.includes(`WORKER_BUILD_VERSION=${SOURCE_SHA}`), 'baked_build_version_mismatch');
  ensure(!env.some(item => /^(NODE_OPTIONS|NODE_PATH|LD_PRELOAD|LD_LIBRARY_PATH)=/.test(item)),
    'image_execution_injection_environment_rejected');
  ensure(!meta.Config?.Volumes || Object.keys(meta.Config.Volumes).length === 0, 'image_declared_volume_rejected');
  return { imageId: meta.Id, platform: 'linux/amd64', sourceSha: SOURCE_SHA };
}
export function containerArgs(image, name, code) {
  validateImage(image);
  ensure(/^ovd517-inspect-[0-9a-f-]{36}$/.test(name), 'inspection_name_invalid');
  return ['--host', DOCKER_HOST, 'run', '--rm', '--name', name,
    '--pull=never', '--platform=linux/amd64', '--network=none', '--read-only', '--no-healthcheck',
    '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=64',
    '--memory=512m', '--cpus=1', '--workdir=/app', '--entrypoint=node', '-i',
    image, '--input-type=commonjs', '-e', code];
}
function docker(args, options = {}) {
  // The daemon is explicitly local. No host credential/environment is passed into the container.
  return spawnSync('docker', args, {
    encoding: 'utf8', timeout: 20_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
    env: { PATH: process.env.PATH }, ...options,
  });
}
export function main(argv) {
  ensure(argv.length === 1, 'exactly_one_digest_argument_required');
  const image = validateImage(argv[0]);
  ensure(statSync('/var/run/docker.sock').isSocket(), 'local_docker_socket_missing');
  const directory = new URL('.', import.meta.url);
  const code = readFileSync(new URL('image-inspector.cjs', directory), 'utf8');
  const manifest = readFileSync(new URL('expected-critical-files.json', directory), 'utf8');
  const metadataResult = docker(['--host', DOCKER_HOST, 'image', 'inspect', image]);
  ensure(!metadataResult.error && metadataResult.status === 0, 'local_image_inspect_failed');
  const metadata = validateMetadata(JSON.parse(metadataResult.stdout), image);
  const containerName = `ovd517-inspect-${randomUUID()}`;
  // Retain identity even if an operator interrupts this wrapper or Docker later times out.
  process.stdout.write(`${JSON.stringify({ status: 'inspection_started', image, containerName })}\n`);
  const result = docker(containerArgs(image, containerName, code), { input: manifest, timeout: 120_000 });
  if (result.error || result.status !== 0) {
    const timedOut = result.error?.code === 'ETIMEDOUT';
    process.stdout.write(`${JSON.stringify({ status: 'failed',
      code: timedOut ? 'inspection_timeout' : 'inspection_failed', image, containerName,
      containerState: 'not_verified_after_failure',
      nextAction: 'Stop here. No retry. Retain this exact container identity for separately approved operator handling.',
    })}\n`);
    process.exitCode = 1;
    return;
  }
  const evidence = JSON.parse(result.stdout);
  ensure(evidence.schema === 'ovd419.offline-image-inspection.v1' && evidence.status === 'passed' &&
    evidence.sourceSha === SOURCE_SHA && evidence.criticalFileCount === 107 && evidence.distFileCount === 105 &&
    evidence.criticalManifestSha256 === createHash('sha256').update(manifest).digest('hex'),
    'inspection_evidence_mismatch');
  process.stdout.write(`${JSON.stringify({ status: 'passed', image, containerName, ...metadata,
    inspectorSha256: createHash('sha256').update(code).digest('hex'), evidence })}\n`);
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { main(process.argv.slice(2)); }
  catch (error) {
    const code = /^[a-z_]+$/.test(error.message) ? error.message : 'inspection_preflight_or_evidence_failed';
    process.stdout.write(`${JSON.stringify({ status: 'failed', code })}\n`);
    process.exitCode = 1;
  }
}
