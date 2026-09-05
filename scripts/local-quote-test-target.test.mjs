// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { resolveLocalQuoteTestTarget } from "./local-quote-test-target.mjs";

const repoRoot = "/repo/Overdrafter";
const config = 'project_id = "quote-test"\n[auth]\nenabled = true\n';
const status = 'API_URL="http://127.0.0.1:54321"\nANON_KEY="local-anon"\nSERVICE_ROLE_KEY="local-service"\n';

function harness({ configText = config, statusText = status, container = "/supabase_db_quote-test true", endpoint = "unix:///var/run/docker.sock", env = {} } = {}) {
  const readConfig = vi.fn(() => configText);
  const run = vi.fn((command, args) => {
    if (command === "supabase") return statusText;
    if (args[0] === "context") return endpoint;
    if (command === "docker") return container;
    throw new Error("Unexpected command");
  });
  return { run, readConfig, resolve: () => resolveLocalQuoteTestTarget({ repoRoot, env, run, readConfig }) };
}

describe("local quote integration target", () => {
  it("binds CLI status and SQL to the configured exact container before returning credentials", () => {
    const { resolve, run, readConfig } = harness();
    const target = resolve();
    expect(readConfig).toHaveBeenCalledWith(`${repoRoot}/supabase/config.toml`, "utf8");
    expect(run.mock.calls.map(([command, args]) => [command, args])).toEqual([
      ["docker", ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"]],
      ["supabase", ["status", "-o", "env", "--workdir", repoRoot]],
      ["docker", ["inspect", "--type", "container", "--format", "{{.Name}} {{.State.Running}}", "supabase_db_quote-test"]],
    ]);
    for (const [, , options] of run.mock.calls) expect(options.cwd).toBe(repoRoot);
    expect(target).toEqual({
      supabaseUrl: "http://127.0.0.1:54321", anonKey: "local-anon", serviceRoleKey: "local-service", containerName: "supabase_db_quote-test",
    });
    expect(Object.isFrozen(target)).toBe(true);
  });

  it.each(["", 'project_id = "../other"', 'project_id = "a"\nproject_id = "b"', '[auth]\nproject_id = "other"'])("rejects invalid root project config %j without commands", (configText) => {
    const { resolve, run } = harness({ configText });
    expect(resolve).toThrow("project_id");
    expect(run).not.toHaveBeenCalled();
  });

  it("accepts indented root declarations and ignores project IDs after the first section", () => {
    const configText = '\r\n  # local project\r\n\tproject_id = "quote-test" # owned stack\r\n  [auth]\r\nproject_id = "other"\r\n';
    expect(harness({ configText }).resolve().containerName).toBe("supabase_db_quote-test");
  });

  it("rejects indented duplicate root declarations before any local commands", () => {
    const configText = '  project_id = "quote-test"\n\tproject_id = "other"\n[auth]\n';
    const { resolve, run } = harness({ configText });
    expect(resolve).toThrow("project_id");
    expect(run).not.toHaveBeenCalled();
  });

  it("handles a long whitespace-only root preamble without repeated multiline scanning", () => {
    const configText = `${" ".repeat(100_000)}\n${config}`;
    expect(harness({ configText }).resolve().containerName).toBe("supabase_db_quote-test");
  });

  it("fails when config cannot be read", () => {
    const { resolve, run, readConfig } = harness();
    readConfig.mockImplementation(() => { throw new Error("private path"); });
    expect(resolve).toThrow("Cannot read supabase/config.toml");
    expect(run).not.toHaveBeenCalled();
  });

  it("fails on missing CLI/local stack without exposing captured credentials", () => {
    const { resolve, run } = harness();
    run.mockImplementation((command, args) => {
      if (args[0] === "context") return "unix:///var/run/docker.sock";
      throw new Error("PRIVATE-KEY");
    });
    expect(resolve).toThrow("Unable to obtain local Supabase status");
    expect(resolve).not.toThrow("PRIVATE-KEY");
    expect(run.mock.calls.every(([command, args]) => command === "supabase" || args[0] === "context")).toBe(true);
  });

  it.each([
    "", status.replace('ANON_KEY="local-anon"\n', ""), status.replace('SERVICE_ROLE_KEY="local-service"', 'SERVICE_ROLE_KEY=""'),
    `${status}API_URL="http://127.0.0.1:54321"\n`, `${status}not-env\n`, status.replace('ANON_KEY="local-anon"', 'ANON_KEY="has spaces"'),
  ])("rejects missing or malformed status %# before Docker/client/SQL access", (statusText) => {
    const { resolve, run } = harness({ statusText });
    expect(resolve).toThrow("Quote integration requires");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it.each([
    "https://hosted.supabase.co", "http://192.168.1.3:54321", "http://127.0.0.1.attacker.test:54321", "not-a-url",
    "http://user:password@127.0.0.1:54321", "http://127.0.0.1:54321/path", "http://127.0.0.1:54321?target=other", "http://localhost",
  ])("rejects unsafe API target %s before Docker/client/SQL access", (url) => {
    const { resolve, run } = harness({ statusText: status.replace("http://127.0.0.1:54321", url) });
    expect(resolve).toThrow("API_URL");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it.each(["SUPABASE_URL", "API_URL", "SUPABASE_ANON_KEY", "ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "SERVICE_ROLE_KEY"])("rejects mismatched %s overrides before Docker/client/SQL access", (alias) => {
    const { resolve, run } = harness({ env: { [alias]: "unrelated-hosted-value" } });
    expect(resolve).toThrow(`${alias} conflicts`);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("allows matching aliases but does not let SUPABASE_WORKDIR replace the explicit workdir", () => {
    const { resolve, run } = harness({ env: { SUPABASE_URL: "http://127.0.0.1:54321", SERVICE_ROLE_KEY: "local-service", ANON_KEY: "local-anon", SUPABASE_WORKDIR: "/other" } });
    expect(resolve().containerName).toBe("supabase_db_quote-test");
    expect(run.mock.calls.find(([command]) => command === "supabase")[1]).toContain(repoRoot);
  });

  it.each(["", "/supabase_db_unrelated true", "/supabase_db_quote-test false", "/supabase_db_quote-test true\n/supabase_db_unrelated true"])("rejects absent, stopped, other, or multiple containers %j", (container) => {
    expect(harness({ container }).resolve).toThrow("exact local database container is not running");
  });

  it("fails closed when exact container inspection fails", () => {
    const { resolve, run } = harness();
    run.mockImplementation((command, args) => {
      if (args[0] === "context") return "unix:///var/run/docker.sock";
      if (command === "supabase") return status;
      throw new Error("unrelated containers exist");
    });
    expect(resolve).toThrow("exact local database container is unavailable");
    expect(run).toHaveBeenCalledTimes(3);
  });

  it.each(["tcp://remote:2375", "ssh://remote", "unix://relative", "npipe:////remote/pipe/docker_engine"])("rejects remote or malformed DOCKER_HOST %s before commands", (DOCKER_HOST) => {
    const { resolve, run } = harness({ env: { DOCKER_HOST } });
    expect(resolve).toThrow("DOCKER_HOST must identify a local Docker socket");
    expect(run).not.toHaveBeenCalled();
  });

  it.each(["tcp://remote:2375", "ssh://remote", "", "unix:///var/run/docker.sock\nunix:///other.sock"])("rejects a nonlocal saved Docker context %j before Supabase status", (endpoint) => {
    const { resolve, run } = harness({ endpoint });
    expect(resolve).toThrow("selected Docker context must identify a local Docker socket");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("rejects a remote selected context even when DOCKER_HOST is local", () => {
    const { resolve, run } = harness({ endpoint: "ssh://remote", env: { DOCKER_CONTEXT: "remote-selected", DOCKER_HOST: "unix:///var/run/docker.sock" } });
    expect(resolve).toThrow("selected Docker context must identify a local Docker socket");
    expect(run.mock.calls[0][1]).toEqual(["context", "inspect", "--format", "{{.Endpoints.docker.Host}}", "remote-selected"]);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("accepts an explicitly selected local context", () => {
    const { resolve, run } = harness({ env: { DOCKER_CONTEXT: "desktop-linux" } });
    expect(resolve().containerName).toBe("supabase_db_quote-test");
    expect(run.mock.calls[0][1]).toContain("desktop-linux");
  });

  it("rejects a shadowed remote host so Docker and Supabase cannot interpret it differently", () => {
    const { resolve, run } = harness({ env: { DOCKER_CONTEXT: "desktop-linux", DOCKER_HOST: "ssh://remote" } });
    expect(resolve).toThrow("DOCKER_HOST must identify a local Docker socket");
    expect(run).not.toHaveBeenCalled();
  });

  it.each(["unix:///var/run/docker.sock", "npipe:////./pipe/docker_engine"])("lets an explicit local host %s override the saved context", (DOCKER_HOST) => {
    const { resolve, run } = harness({ endpoint: "ssh://remote", env: { DOCKER_HOST } });
    expect(resolve().containerName).toBe("supabase_db_quote-test");
    expect(run.mock.calls[0][0]).toBe("supabase");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("scrubs failures while reading local context metadata", () => {
    const { resolve, run } = harness();
    run.mockImplementation(() => { throw new Error("private endpoint"); });
    expect(resolve).toThrow("Cannot resolve the selected Docker context locally");
    expect(resolve).not.toThrow("private endpoint");
    expect(run.mock.calls.every(([, args]) => args[0] === "context")).toBe(true);
  });
});
