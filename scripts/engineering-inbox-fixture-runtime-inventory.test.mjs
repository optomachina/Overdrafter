// @vitest-environment node
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import process from "node:process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { createEngineeringInboxFixturePlan } from "./engineering-inbox-fixture-plan.mjs";
import { inspectEngineeringInboxFixtureInventory } from "./engineering-inbox-fixture-runtime-inventory.mjs";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

const uuid = (digit) => `${digit.repeat(8)}-${digit.repeat(4)}-7${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
const sha = (digit) => digit.repeat(64);
const securityOptions = ["name=seccomp,profile=default"];
const securityOptionsSha256 = createHash("sha256").update(JSON.stringify(securityOptions)).digest("hex");
const inherited = ["DOCKER_AUTH_CONFIG", "DOCKER_CERT_PATH", "DOCKER_CONFIG", "DOCKER_CONTEXT",
  "DOCKER_HOST", "DOCKER_TLS", "DOCKER_TLS_VERIFY"];
const plan = createEngineeringInboxFixturePlan({ sourceRevision: "d".repeat(40), ownerTaskId: uuid("1"), runId: uuid("2"),
  databaseImage: `sha256:${sha("3")}`, postgrestImage: `sha256:${sha("4")}`,
  migrations: [{ path: "supabase/migrations/20260910045917_engineering_durable_inbox.sql", sha256: sha("5") }] });
const admission = { schema: "overdrafter.engineering-inbox-fixture-runtime-inventory-admission.v1",
  identity: { hostId: "fixture-host", ownerTaskId: plan.identity.ownerTaskId, runId: plan.identity.runId,
    sourceRevision: plan.identity.sourceRevision, sourceTree: "e".repeat(40) },
  docker: { client: { path: "/usr/local/bin/docker", sha256: sha("6") },
    configPath: "/private/tmp/ovd-fixture/docker-config", enrollmentReceiptSha256: sha("7"),
    socket: { path: "/private/var/run/docker.sock", canonicalPath: "/private/var/run/docker.sock",
      device: 1, inode: 2, mode: "0600", ownerId: 501 },
    daemon: { dockerRootDir: "/var/lib/docker", engineId: "engine-fixture", name: "fixture-daemon",
      operatingSystem: "Docker Desktop", osType: "linux", securityOptionsSha256 } },
  limits: { actionMs: 10_000, gracefulStopMs: 250, hardStopMs: 2_000,
    stdoutBytes: 1024 * 1024, stderrBytes: 256 * 1024, envelopeBytes: 512 * 1024 } };
const info = { DockerRootDir: "/var/lib/docker", ID: "engine-fixture", Name: "fixture-daemon",
  OperatingSystem: "Docker Desktop", OSType: "linux", SecurityOptions: securityOptions };
const prefix = `ovd496-${plan.identity.runId}`;
const ids = { database: sha("a"), postgrest: sha("b"), network: sha("c") };
const labelObject = (role) => ({ contract: plan.schema, ownerTaskId: plan.identity.ownerTaskId, role,
  runId: plan.identity.runId, sourceRevision: plan.identity.sourceRevision });
const labelText = (role) => Object.entries(labelObject(role)).map(([key, value]) => `${key}=${value}`).join(",");

class FakeStream extends EventEmitter {}
class FakeChild extends EventEmitter {
  constructor(pid = 4321) { super(); this.pid = pid; this.stdout = new FakeStream(); this.stderr = new FakeStream(); }
  complete({ stdout = "", stderr = "", code = 0 } = {}) {
    queueMicrotask(() => {
      if (stdout) this.stdout.emit("data", Buffer.from(stdout));
      if (stderr) this.stderr.emit("data", Buffer.from(stderr));
      this.stdout.emit("close");
      this.stderr.emit("close");
      this.emit("close", code);
    });
    return this;
  }
  stop({ code = null } = {}) {
    this.stdout.emit("close"); this.stderr.emit("close"); this.emit("close", code);
  }
}

function queue(...outcomes) {
  spawn.mockImplementation(() => {
    const outcome = outcomes.shift();
    if (outcome instanceof Error) throw outcome;
    return outcome instanceof FakeChild ? outcome : new FakeChild().complete(outcome);
  });
}

function containerInspect(role, overrides = {}) {
  const caps = plan.resourcePolicy.containers[role];
  return { Id: ids[role], Name: `/${prefix}-${role}`, Config: { Image: plan.images[role].id, Labels: labelObject(role) },
    HostConfig: { Binds: [], Memory: caps.memoryBytes, NanoCpus: 1_000_000_000, NetworkMode: `${prefix}-network`,
      PidsLimit: caps.pids, PortBindings: role === "database" ? {} : { "3000/tcp": [{ HostIp: "127.0.0.1", HostPort: "49152" }] },
      Privileged: false, ReadonlyRootfs: true, Tmpfs: Object.fromEntries(caps.tmpfs.map((path) => [path, "rw"])) },
    Mounts: [], ...overrides };
}

function networkInspect(overrides = {}) {
  return { Id: ids.network, Name: `${prefix}-network`, Labels: labelObject("network"), Internal: true, ...overrides };
}

function listRow(role) {
  return role === "network" ? { ID: ids.network, Name: `${prefix}-network`, Labels: labelText(role) }
    : { ID: ids[role], Names: `${prefix}-${role}`, Labels: labelText(role) };
}

beforeEach(() => {
  spawn.mockReset();
  vi.spyOn(process, "kill").mockReturnValue(true);
  for (const key of inherited) delete process.env[key];
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const key of inherited) delete process.env[key];
});

describe("engineering inbox runtime inventory source boundary", () => {
  it("normalizes Docker info and an exact empty inventory without a public side effect", async () => {
    queue({ stdout: JSON.stringify(info) }, { stdout: "" }, { stdout: "" }, { stdout: "" }, { stdout: "" });
    const result = await inspectEngineeringInboxFixtureInventory({ plan, admission });
    expect(result).toEqual({ schema: "overdrafter.engineering-inbox-fixture-runtime-inventory-result.v1",
      qualification: "source_contract_only", admissionEvidence: "unverified", collisionStatus: "clear",
      candidateCount: 0, candidates: [] });
    expect(spawn.mock.calls.map(([, args]) => args)).toEqual([
      ["info", "--format", "{{json .}}"],
      ["container", "ls", "--all", "--no-trunc", "--format", "{{json .}}"],
      ["container", "ls", "--all", "--no-trunc", "--filter", `label=runId=${plan.identity.runId}`,
        "--format", "{{json .}}"],
      ["network", "ls", "--no-trunc", "--format", "{{json .}}"],
      ["network", "ls", "--no-trunc", "--filter", `label=runId=${plan.identity.runId}`,
        "--format", "{{json .}}"],
    ]);
    for (const [, , options] of spawn.mock.calls) {
      expect(options).toMatchObject({ detached: true, shell: false,
        env: { DOCKER_CONFIG: admission.docker.configPath,
          DOCKER_HOST: `unix://${admission.docker.socket.canonicalPath}`, LANG: "C", LC_ALL: "C" } });
      expect(Object.keys(options.env)).toHaveLength(4);
    }
  });

  it("includes exact-name and run-id candidates, including stopped containers, then inspects each type", async () => {
    const renamed = { ID: ids.postgrest, Names: "renamed-stopped", Labels: labelText("postgrest"), State: "exited" };
    queue({ stdout: JSON.stringify(info) },
      { stdout: `${JSON.stringify(listRow("database"))}\n` },
      { stdout: `${JSON.stringify(renamed)}\n` },
      { stdout: `${JSON.stringify(listRow("network"))}\n` },
      { stdout: `${JSON.stringify(listRow("network"))}\n` },
      { stdout: JSON.stringify([containerInspect("database"),
        containerInspect("postgrest", { Name: "/renamed-stopped" })]) },
      { stdout: JSON.stringify([networkInspect()]) });
    const result = await inspectEngineeringInboxFixtureInventory({ plan, admission });
    expect(result.collisionStatus).toBe("collision");
    expect(result.candidateCount).toBe(3);
    expect(result.candidates.map(({ classification }) => classification)).toEqual([
      "inventory_exact", "inventory_drift", "inventory_exact"]);
    expect(spawn.mock.calls[5][1].slice(0, 2)).toEqual(["container", "inspect"]);
    expect(spawn.mock.calls[6][1].slice(0, 2)).toEqual(["network", "inspect"]);
  });

  it.each(inherited)("rejects inherited %s before constructing a child", async (key) => {
    process.env[key] = "private-canary";
    await expect(inspectEngineeringInboxFixtureInventory({ plan, admission })).rejects.toThrow(
      "inherited_docker_configuration");
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each(["engineId", "name", "operatingSystem", "osType", "dockerRootDir", "securityOptions"])(
    "fails closed on %s daemon drift", async (field) => {
      const changed = structuredClone(info);
      if (field === "securityOptions") changed.SecurityOptions = ["private-drift"];
      else changed[{ engineId: "ID", name: "Name", operatingSystem: "OperatingSystem", osType: "OSType",
        dockerRootDir: "DockerRootDir" }[field]] = "private-drift";
      queue({ stdout: JSON.stringify(changed) });
      await expect(inspectEngineeringInboxFixtureInventory({ plan, admission })).rejects.toThrow("daemon_identity_unproved");
    });

  it("does not filter a malformed exact-name candidate into an empty inventory", async () => {
    queue({ stdout: JSON.stringify(info) },
      { stdout: `${JSON.stringify({ ID: "short", Names: `${prefix}-database`, Labels: "" })}\n` },
      { stdout: "" }, { stdout: "" }, { stdout: "" });
    await expect(inspectEngineeringInboxFixtureInventory({ plan, admission })).rejects.toThrow("inventory_uncertain");
  });

  it("rejects duplicate candidate identities", async () => {
    const row = listRow("database");
    queue({ stdout: JSON.stringify(info) }, { stdout: `${JSON.stringify(row)}\n${JSON.stringify(row)}\n` },
      { stdout: "" }, { stdout: "" }, { stdout: "" });
    await expect(inspectEngineeringInboxFixtureInventory({ plan, admission })).rejects.toThrow("inventory_uncertain");
  });

  it.each([
    ["missing labels", (value) => { value.Config.Labels = {}; }],
    ["memory drift", (value) => { value.HostConfig.Memory += 1; }],
    ["host mount", (value) => { value.Mounts.push({ Type: "bind" }); }],
    ["public binding", (value) => { value.HostConfig.PortBindings["3000/tcp"][0].HostIp = "0.0.0.0"; }],
  ])("retains an exact-name candidate with %s as a collision", async (_label, mutate) => {
    const role = _label === "public binding" ? "postgrest" : "database";
    const inspected = containerInspect(role);
    mutate(inspected);
    queue({ stdout: JSON.stringify(info) }, { stdout: `${JSON.stringify(listRow(role))}\n` }, { stdout: "" },
      { stdout: "" }, { stdout: "" }, { stdout: JSON.stringify([inspected]) });
    const result = await inspectEngineeringInboxFixtureInventory({ plan, admission });
    expect(result).toMatchObject({ collisionStatus: "collision", candidateCount: 1,
      candidates: [{ classification: "inventory_drift" }] });
  });

  it.each([
    ["malformed output", "{", "invalid_envelope"],
    ["nonzero exit", "", "child_failed", 1],
    ["oversized output", "x".repeat(1024 * 1024 + 1), "output_limit"],
  ])("classifies %s without raw diagnostics", async (_label, stdout, code, exitCode = 0) => {
    queue({ stdout, stderr: "private-canary", code: exitCode });
    const error = await inspectEngineeringInboxFixtureInventory({ plan, admission }).catch((value) => value);
    expect(error.code).toBe(code);
    expect(JSON.stringify(error)).not.toContain("private-canary");
  });

  it("uses one total deadline rather than resetting ten seconds per Docker command", async () => {
    const now = vi.spyOn(Date, "now");
    now.mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValueOnce(6_000).mockReturnValueOnce(11_000);
    queue({ stdout: JSON.stringify(info) }, { stdout: "" });
    await expect(inspectEngineeringInboxFixtureInventory({ plan, admission })).rejects.toThrow("timed_out");
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("keeps timeout distinct when the owned child termination is proved", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    queue(child);
    process.kill.mockImplementation((_pid, signal) => { if (signal === "SIGTERM") queueMicrotask(() => child.stop()); return true; });
    const outcome = inspectEngineeringInboxFixtureInventory({ plan, admission }).catch((error) => error);
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await outcome).code).toBe("timed_out");
  });

  it("keeps active abort distinct when the owned child termination is proved", async () => {
    const controller = new AbortController();
    const child = new FakeChild();
    queue(child);
    process.kill.mockImplementation((_pid, signal) => { if (signal === "SIGTERM") queueMicrotask(() => child.stop()); return true; });
    const outcome = inspectEngineeringInboxFixtureInventory({ plan, admission, signal: controller.signal })
      .catch((error) => error);
    controller.abort();
    expect((await outcome).code).toBe("aborted");
  });

  it("uses process_stop_unproved only when the child and streams cannot be proved terminal", async () => {
    vi.useFakeTimers();
    queue(new FakeChild());
    const outcome = inspectEngineeringInboxFixtureInventory({ plan, admission }).catch((error) => error);
    await vi.advanceTimersByTimeAsync(12_251);
    expect((await outcome).code).toBe("process_stop_unproved");
  });

  it("rejects a pre-start abort without constructing a child", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(inspectEngineeringInboxFixtureInventory({ plan, admission, signal: controller.signal }))
      .rejects.toThrow("aborted");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects extra admission keys and never starts", async () => {
    await expect(inspectEngineeringInboxFixtureInventory({ plan, admission: { ...admission, private: true } }))
      .rejects.toThrow("invalid_admission");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects admission accessors without invoking them", async () => {
    const trapped = vi.fn();
    const hostile = { ...admission };
    Object.defineProperty(hostile, "private", { enumerable: true, get: () => { trapped(); return true; } });
    await expect(inspectEngineeringInboxFixtureInventory({ plan, admission: hostile })).rejects.toThrow("invalid_admission");
    expect(trapped).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });
});
