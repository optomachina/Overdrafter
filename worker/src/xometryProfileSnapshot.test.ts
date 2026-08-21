// @vitest-environment node

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "./config";
import { saveCamoufoxLaunchIdentity } from "./camoufoxProfileIdentity";
import {
  createXometryProfileArchive,
  persistXometryProfileSnapshot,
  restoreXometryProfileSnapshot,
  withXometryProfileSnapshotLock,
  XometryProfileSnapshotError,
} from "./xometryProfileSnapshot";

const execFileAsync = promisify(execFile);
const tempPaths: string[] = [];

async function makeArchive(options: { manifest?: boolean; cookieBytes?: number } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "profile-fixture-"));
  tempPaths.push(root);
  await fs.mkdir(path.join(root, "Default"), { recursive: true });
  await fs.writeFile(
    path.join(root, "Default", "Cookies"),
    options.cookieBytes ? Buffer.alloc(options.cookieBytes) : "cookie-db",
  );
  if (options.manifest !== false) {
    await fs.writeFile(
      path.join(root, ".overdrafter-profile.json"),
      JSON.stringify({
        schema: "overdrafter-xometry-profile.v1",
        browserEngine: "playwright",
        savedAt: "2026-08-20T00:00:00.000Z",
      }),
    );
  }
  const archivePath = path.join(root, "profile.tgz");
  await execFileAsync("tar", ["-czf", archivePath, "-C", root, "Default", ...(options.manifest === false ? [] : [".overdrafter-profile.json"])]);
  return fs.readFile(archivePath);
}

function snapshotConfig(workerTempDir: string) {
  return loadConfig({
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
    WORKER_MODE: "live",
    WORKER_TEMP_DIR: workerTempDir,
    XOMETRY_PROFILE_SNAPSHOT_BUCKET: "private-profile-bucket",
    XOMETRY_PROFILE_SNAPSHOT_OBJECT: "xometry/profile.tgz",
  });
}

function tokenResponse() {
  return new Response(JSON.stringify({ access_token: "test-token" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map((entry) => fs.rm(entry, { recursive: true, force: true })));
});

describe("Xometry profile snapshots", () => {
  it("exports a closed Camoufox profile without its singleton lock", async () => {
    const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), "camoufox-profile-"));
    tempPaths.push(profileDir);
    await fs.writeFile(path.join(profileDir, "cookies.sqlite"), "cookie-db");
    await saveCamoufoxLaunchIdentity(profileDir, { "navigator.userAgent": "stable-firefox" });
    await fs.symlink("127.0.0.1:+99999999", path.join(profileDir, "lock"));
    const outputPath = path.join(profileDir, "..", `${path.basename(profileDir)}.tgz`);
    tempPaths.push(outputPath);

    await createXometryProfileArchive({
      userDataDir: profileDir,
      browserEngine: "camoufox",
      outputPath,
    });

    const { stdout } = await execFileAsync("tar", ["-tzf", outputPath]);
    expect(stdout).toContain("./cookies.sqlite");
    expect(stdout).toContain("./.overdrafter-camoufox-identity.json");
    expect(stdout).not.toContain("./lock");
  });

  it("refuses to export a Camoufox profile without a launch identity", async () => {
    const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), "camoufox-profile-"));
    tempPaths.push(profileDir);
    await fs.writeFile(path.join(profileDir, "cookies.sqlite"), "cookie-db");
    const outputPath = path.join(profileDir, "..", `${path.basename(profileDir)}.tgz`);
    tempPaths.push(outputPath);

    await expect(
      createXometryProfileArchive({
        userDataDir: profileDir,
        browserEngine: "camoufox",
        outputPath,
      }),
    ).rejects.toMatchObject<XometryProfileSnapshotError>({
      reason: "snapshot_profile_uninitialized",
    });
  });

  it("refuses to export a Camoufox profile with a live singleton lock", async () => {
    const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), "camoufox-profile-"));
    tempPaths.push(profileDir);
    await fs.writeFile(path.join(profileDir, "cookies.sqlite"), "cookie-db");
    await fs.symlink(`127.0.0.1:+${process.pid}`, path.join(profileDir, "lock"));
    const outputPath = path.join(profileDir, "..", `${path.basename(profileDir)}.tgz`);
    tempPaths.push(outputPath);

    await expect(
      createXometryProfileArchive({
        userDataDir: profileDir,
        browserEngine: "camoufox",
        outputPath,
      }),
    ).rejects.toMatchObject<XometryProfileSnapshotError>({
      reason: "snapshot_unsafe_entry",
    });
  });

  it("still rejects arbitrary profile links", async () => {
    const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), "camoufox-profile-"));
    tempPaths.push(profileDir);
    await fs.writeFile(path.join(profileDir, "cookies.sqlite"), "cookie-db");
    await saveCamoufoxLaunchIdentity(profileDir, { "navigator.userAgent": "stable-firefox" });
    await fs.symlink("/tmp/credential", path.join(profileDir, "unexpected-link"));
    const outputPath = path.join(profileDir, "..", `${path.basename(profileDir)}.tgz`);
    tempPaths.push(outputPath);

    await expect(
      createXometryProfileArchive({
        userDataDir: profileDir,
        browserEngine: "camoufox",
        outputPath,
      }),
    ).rejects.toMatchObject<XometryProfileSnapshotError>({
      reason: "snapshot_unsafe_entry",
    });
  });

  it("serializes concurrent snapshot-backed Camoufox lifecycles", async () => {
    const events: string[] = [];
    let releaseFirst: () => void = () => undefined;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = withXometryProfileSnapshotLock(async () => {
      events.push("camoufox-1-start");
      await firstBlocked;
      events.push("camoufox-1-end");
    });
    const second = withXometryProfileSnapshotLock(async () => {
      events.push("camoufox-2-start");
      events.push("camoufox-2-end");
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toEqual(["camoufox-1-start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual([
      "camoufox-1-start",
      "camoufox-1-end",
      "camoufox-2-start",
      "camoufox-2-end",
    ]);
  });

  it("restores one exact generation into a fresh local profile", async () => {
    const workerTempDir = await fs.mkdtemp(path.join(os.tmpdir(), "profile-worker-"));
    tempPaths.push(workerTempDir);
    const archive = await makeArchive();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ generation: "41", size: String(archive.byteLength) }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(
        new Response(archive, {
          status: 200,
          headers: { "Content-Length": String(archive.byteLength) },
        }),
      );

    const restored = await restoreXometryProfileSnapshot(
      snapshotConfig(workerTempDir),
      fetchMock,
    );

    expect(restored.xometryProfileSnapshotGeneration).toBe("41");
    expect(await fs.readFile(path.join(restored.xometryUserDataDir as string, "Default", "Cookies"), "utf8")).toBe("cookie-db");
    expect(fetchMock.mock.calls[3]?.[0]).toContain("generation=41");
  });

  it("rejects a snapshot without the required manifest", async () => {
    const workerTempDir = await fs.mkdtemp(path.join(os.tmpdir(), "profile-worker-"));
    tempPaths.push(workerTempDir);
    const archive = await makeArchive({ manifest: false });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(new Response(JSON.stringify({ generation: "2", size: String(archive.byteLength) })))
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(new Response(archive));

    await expect(
      restoreXometryProfileSnapshot(snapshotConfig(workerTempDir), fetchMock),
    ).rejects.toMatchObject<XometryProfileSnapshotError>({
      reason: "snapshot_manifest_missing",
    });
  });

  it("rejects an archive that expands beyond the configured limit", async () => {
    const workerTempDir = await fs.mkdtemp(path.join(os.tmpdir(), "profile-worker-"));
    tempPaths.push(workerTempDir);
    const archive = await makeArchive({ cookieBytes: 4096 });
    expect(archive.byteLength).toBeLessThan(1024);
    const config = loadConfig({
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
      WORKER_MODE: "live",
      WORKER_TEMP_DIR: workerTempDir,
      XOMETRY_PROFILE_SNAPSHOT_BUCKET: "private-profile-bucket",
      XOMETRY_PROFILE_SNAPSHOT_OBJECT: "xometry/profile.tgz",
      XOMETRY_PROFILE_SNAPSHOT_MAX_BYTES: "1024",
    });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(new Response(JSON.stringify({ generation: "2", size: String(archive.byteLength) })))
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(new Response(archive));

    await expect(restoreXometryProfileSnapshot(config, fetchMock)).rejects.toMatchObject<
      XometryProfileSnapshotError
    >({ reason: "snapshot_too_large" });
  });

  it("converts snapshot request timeouts into structured read and write failures", async () => {
    const workerTempDir = await fs.mkdtemp(path.join(os.tmpdir(), "profile-worker-"));
    tempPaths.push(workerTempDir);
    const config = snapshotConfig(workerTempDir);
    const timeout = new DOMException("timed out", "TimeoutError");

    await expect(
      restoreXometryProfileSnapshot(config, vi.fn<typeof fetch>().mockRejectedValue(timeout)),
    ).rejects.toMatchObject<XometryProfileSnapshotError>({ reason: "snapshot_read_failed" });

    await fs.mkdir(path.join(config.xometryUserDataDir as string, "Default"), { recursive: true });
    await fs.writeFile(path.join(config.xometryUserDataDir as string, "Default", "Cookies"), "cookie-db");
    config.xometryProfileSnapshotGeneration = "41";
    const writeFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(tokenResponse())
      .mockRejectedValueOnce(timeout);
    await expect(persistXometryProfileSnapshot(config, writeFetch)).rejects.toMatchObject<
      XometryProfileSnapshotError
    >({ reason: "snapshot_write_failed" });
  });

  it("persists only with the restored generation precondition", async () => {
    const workerTempDir = await fs.mkdtemp(path.join(os.tmpdir(), "profile-worker-"));
    tempPaths.push(workerTempDir);
    const config = snapshotConfig(workerTempDir);
    await fs.mkdir(path.join(config.xometryUserDataDir as string, "Default"), { recursive: true });
    await fs.writeFile(path.join(config.xometryUserDataDir as string, "Default", "Cookies"), "cookie-db");
    config.xometryProfileSnapshotGeneration = "41";
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(new Response(JSON.stringify({ generation: "42" }), { status: 200 }));

    const persisted = await persistXometryProfileSnapshot(config, fetchMock);

    expect(persisted.xometryProfileSnapshotGeneration).toBe("42");
    expect(fetchMock.mock.calls[1]?.[0]).toContain("ifGenerationMatch=41");
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: "POST" });
  });

  it("fails closed when another writer replaced the snapshot", async () => {
    const workerTempDir = await fs.mkdtemp(path.join(os.tmpdir(), "profile-worker-"));
    tempPaths.push(workerTempDir);
    const config = snapshotConfig(workerTempDir);
    await fs.mkdir(path.join(config.xometryUserDataDir as string, "Default"), { recursive: true });
    await fs.writeFile(path.join(config.xometryUserDataDir as string, "Default", "Cookies"), "cookie-db");
    config.xometryProfileSnapshotGeneration = "41";
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(new Response("conflict", { status: 412 }));

    await expect(persistXometryProfileSnapshot(config, fetchMock)).rejects.toMatchObject<
      XometryProfileSnapshotError
    >({ reason: "snapshot_generation_conflict" });
  });
});
