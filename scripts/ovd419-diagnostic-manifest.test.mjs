import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, chmod, unlink, symlink, stat, writeFile, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { validatePrivateManifest, createPrivateManifest } from "./ovd419-diagnostic-manifest.mjs";
import { packet, manifestFixture } from "./ovd419-diagnostic-test-fixtures.mjs";
import { digest } from "./ovd419-job-diagnostic.mjs";

// Count real filesystem creation calls, including artifacts removed before rejection.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, mkdtemp: vi.fn(actual.mkdtemp), open: vi.fn(actual.open) };
});

const cleanup = [];
afterEach(async () => { for (const p of cleanup.splice(0)) await rm(p, { recursive: true, force: true }); });
function fixture() {
  const p = packet(), value = manifestFixture(p);
  p.baseline.job.configuration = digest({ name: value.metadata.name, spec: value.spec });
  return { p, value };
}
describe("strict full manifest projection", () => {
  it("preserves every accepted field and array order", () => {
    const { p, value } = fixture(), before = JSON.stringify(value);
    expect(validatePrivateManifest(value, p).toString()).toBe(before);
    expect(JSON.stringify(value)).toBe(before);
  });
  it.each([
    ["unknown env", (v) => v.spec.template.spec.template.spec.containers[0].env.push({ name: "TEST_ONLY_API_KEY", value: "TEST_ONLY_NOT_A_SECRET" })],
    ["nested env extras", (v) => { v.spec.template.spec.template.spec.containers[0].env[0].extra = "TEST_ONLY_NOT_A_SECRET"; }],
    ["secret reference", (v) => { v.spec.template.spec.template.spec.containers[0].env[0].valueFrom = { secretKeyRef: { name: "TEST_ONLY", key: "1" } }; }],
    ["wrong fixed env", (v) => { v.spec.template.spec.template.spec.containers[0].env[0].value = "TEST_ONLY_NOT_A_SECRET"; }],
    ["unknown annotation", (v) => { v.metadata.annotations.TEST_ONLY_TOKEN = "TEST_ONLY_NOT_A_SECRET"; }],
    ["unknown label", (v) => { v.metadata.labels.TEST_ONLY_TOKEN = "TEST_ONLY_NOT_A_SECRET"; }],
    ["unknown task field", (v) => { v.spec.template.spec.template.spec.volumes = [{ secret: "TEST_ONLY_NOT_A_SECRET" }]; }],
    ["unknown top field", (v) => { v.TEST_ONLY_TOKEN = "TEST_ONLY_NOT_A_SECRET"; }],
    ["extra argument", (v) => { v.spec.template.spec.template.spec.containers[0].args.push("TEST_ONLY_NOT_A_SECRET"); }],
    ["extra network field", (v) => { v.spec.template.metadata.annotations["run.googleapis.com/network-interfaces"] = JSON.stringify([{ network: "overdrafter-xometry-egress", subnetwork: "overdrafter-xometry-egress-us-west1", token: "TEST_ONLY_NOT_A_SECRET" }]); }],
  ])("rejects %s even with a matching approved configuration hash", (_, change) => {
    const { p, value } = fixture(); change(value); p.baseline.job.configuration = digest({ name: value.metadata.name, spec: value.spec });
    expect(() => validatePrivateManifest(value, p)).toThrow("diagnostic_manifest_rejected");
  });
  it("rejects a supported configuration when its exact digest is unbound", () => {
    const { p, value } = fixture(); p.baseline.job.configuration = "e".repeat(64);
    expect(() => validatePrivateManifest(value, p)).toThrow();
  });
});
describe("private inode and cleanup lifecycle", () => {
  it("validates before creating any directory or file", async () => {
    const { p, value } = fixture(); value.secret = "TEST_ONLY_NOT_A_SECRET";
    const parent = await mkdtemp(path.join(tmpdir(), "ovd419-TEST-ONLY-validation-parent-")); cleanup.push(parent);
    vi.mocked(mkdtemp).mockClear(); vi.mocked(open).mockClear();
    await expect(createPrivateManifest(value, p, { parent })).rejects.toThrow("diagnostic_manifest_rejected");
    expect(mkdtemp).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled();
  });
  it("cleans up with a fresh local budget after the preparation deadline", async () => {
    const { p, value } = fixture(), evidence = {};
    let now = 1000;
    const file = await createPrivateManifest(value, p, { deadlineAt: 2000, now: () => now, evidence });
    cleanup.push(path.dirname(file.path));
    now = 3000;
    expect(await file.dispose()).toBe(true);
    expect(evidence.cleanup).toBe("removed");
    await expect(stat(file.path)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("creates0700/0600, verifies bytes and removes only its own file/directory", async () => {
    const { p, value } = fixture(); const file = await createPrivateManifest(value, p);
    cleanup.push(path.dirname(file.path));
    expect((await stat(path.dirname(file.path))).mode & 0o777).toBe(0o700);
    expect((await stat(file.path)).mode & 0o777).toBe(0o600);
    expect(await readFile(file.path, "utf8")).toBe(JSON.stringify(value));
    await file.verify(); expect(await file.dispose()).toBe(true);
    await expect(stat(file.path)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it.each(["bytes", "mode", "symlink", "directory"])("refuses %s substitution before command use", async (kind) => {
    const { p, value } = fixture(); const file = await createPrivateManifest(value, p);
    cleanup.push(path.dirname(file.path));
    if (kind === "bytes") await writeFile(file.path, "TEST_ONLY_CHANGED");
    if (kind === "mode") await chmod(file.path, 0o644);
    if (kind === "directory") await chmod(path.dirname(file.path), 0o755);
    if (kind === "symlink") {
      const targetDir = await mkdtemp(path.join(tmpdir(), "ovd419-TEST-ONLY-target-")); cleanup.push(targetDir);
      const target = path.join(targetDir, "keep"); await writeFile(target, "TEST_ONLY_KEEP", { mode: 0o600 });
      await unlink(file.path); await symlink(target, file.path);
    }
    await expect(file.verify()).rejects.toThrow("diagnostic_manifest_rejected");
    const disposed = await file.dispose();
    if (kind === "symlink" || kind === "directory") expect(disposed).toBe(false);
  });
  it("does not recursively delete unexpected directory entries", async () => {
    const { p, value } = fixture(); const file = await createPrivateManifest(value, p); cleanup.push(path.dirname(file.path));
    const extra = path.join(path.dirname(file.path), "TEST_ONLY_KEEP"); await writeFile(extra, "TEST_ONLY_KEEP");
    expect(await file.dispose()).toBe(false); expect(await readFile(extra, "utf8")).toBe("TEST_ONLY_KEEP");
  });
});


describe("manifest abort paths", () => {
  it("a pre-aborted invocation cannot create a file", async () => {
    const { p, value } = fixture(), controller = new AbortController(), evidence = {};
    controller.abort(); await expect(createPrivateManifest(value, p, { signal: controller.signal, evidence })).rejects.toThrow("diagnostic_manifest_rejected");
    expect(evidence.directoryCreated).toBe(false); expect(evidence.fileCreated).toBe(false);
  });
  it("an aborted preparation prevents use but still permits bounded local cleanup", async () => {
    const { p, value } = fixture(), controller = new AbortController(), evidence = {};
    const file = await createPrivateManifest(value, p, { signal: controller.signal, evidence }); cleanup.push(path.dirname(file.path));
    controller.abort(); await expect(file.verify()).rejects.toThrow(); expect(await file.dispose()).toBe(true);
    expect(evidence.cleanup).toBe("removed"); expect(await file.dispose()).toBe(true);
  });
});


describe("temporary-parent boundary", () => {
  it("supports the root-owned sticky OS temp directory while creating a private child", async () => {
    const { p, value } = fixture();
    const parent = process.platform === "darwin" ? "/private/tmp" : "/tmp";
    const file = await createPrivateManifest(value, p, { parent }); cleanup.push(path.dirname(file.path));
    expect((await stat(path.dirname(file.path))).mode & 0o7777).toBe(0o700);
    expect(await file.dispose()).toBe(true);
  });
  it("rejects a writable non-sticky parent before creating a child", async () => {
    const { p, value } = fixture(), evidence = {};
    const parent = await mkdtemp(path.join(tmpdir(), "ovd419-TEST-ONLY-unsafe-parent-")); cleanup.push(parent);
    await chmod(parent, 0o777);
    await expect(createPrivateManifest(value, p, { parent, evidence })).rejects.toThrow();
    expect(evidence.directoryCreated).toBe(false); expect(evidence.fileCreated).toBe(false);
  });
});


describe("embedded network JSON duplicate keys", () => {
  it.each([
    ["ordinary network", '"network"', "network"],
    ["escaped network", String.raw`"net\u0077ork"`, "network"],
    ["ordinary subnetwork", '"subnetwork"', "subnetwork"],
    ["escaped subnetwork", String.raw`"subnet\u0077ork"`, "subnetwork"],
  ])("rejects %s before any directory or file creation", async (_, key, decoded) => {
    const { p, value } = fixture();
    const annotations = value.spec.template.metadata.annotations;
    const field = "run.googleapis.com/network-interfaces";
    const valid = JSON.parse(annotations[field])[0];
    annotations[field] = `[{${key}:"TEST_ONLY_NOT_A_SECRET",${JSON.stringify(decoded)}:${JSON.stringify(valid[decoded])},${JSON.stringify(decoded === "network" ? "subnetwork" : "network")}:${JSON.stringify(valid[decoded === "network" ? "subnetwork" : "network"])}}]`;
    p.baseline.job.configuration = digest({ name: value.metadata.name, spec: value.spec });
    vi.mocked(mkdtemp).mockClear(); vi.mocked(open).mockClear();
    await expect(createPrivateManifest(value, p).then(async (file) => {
      // Keep the failing red run contained if the old implementation accepts it.
      await file.dispose(); return file;
    })).rejects.toThrow("diagnostic_manifest_rejected");
    expect(mkdtemp).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled();
  });
  it.each([
    ["two equal decoded keys", String.raw`[{"network":"TEST_ONLY","net\u0077ork":"TEST_ONLY"}]`],
    ["invalid escape", String.raw`[{"net\x77ork":"TEST_ONLY","subnetwork":"TEST_ONLY"}]`],
    ["unescaped newline", '[{"net\nwork":"TEST_ONLY","subnetwork":"TEST_ONLY"}]'],
    ["non-JSON whitespace", '\v[{"network":"TEST_ONLY","subnetwork":"TEST_ONLY"}]'],
    ["missing colon", '[{"network" "TEST_ONLY","subnetwork":"TEST_ONLY"}]'],
    ["trailing comma", '[{"network":"TEST_ONLY","subnetwork":"TEST_ONLY",}]'],
    ["non-string field", '[{"network":{},"subnetwork":"TEST_ONLY"}]'],
    ["trailing data", '[{"network":"TEST_ONLY","subnetwork":"TEST_ONLY"}][]'],
  ])("rejects %s without filesystem creation", async (_, raw) => {
    const { p, value } = fixture();
    value.spec.template.metadata.annotations["run.googleapis.com/network-interfaces"] = raw;
    p.baseline.job.configuration = digest({ name: value.metadata.name, spec: value.spec });
    vi.mocked(mkdtemp).mockClear(); vi.mocked(open).mockClear();
    await expect(createPrivateManifest(value, p)).rejects.toThrow("diagnostic_manifest_rejected");
    expect(mkdtemp).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled();
  });
  it("preserves accepted escaped keys, whitespace and reversed order exactly", async () => {
    const { p, value } = fixture();
    const annotations = value.spec.template.metadata.annotations;
    const field = "run.googleapis.com/network-interfaces";
    const valid = JSON.parse(annotations[field])[0];
    annotations[field] = `[ { "subnetwork" : ${JSON.stringify(valid.subnetwork)}, ${String.raw`"net\u0077ork"`} : ${JSON.stringify(valid.network)} } ]`;
    p.baseline.job.configuration = digest({ name: value.metadata.name, spec: value.spec });
    const expected = JSON.stringify(value), file = await createPrivateManifest(value, p);
    cleanup.push(path.dirname(file.path));
    expect(await readFile(file.path, "utf8")).toBe(expected);
    await file.verify(); expect(await file.dispose()).toBe(true);
  });
});
