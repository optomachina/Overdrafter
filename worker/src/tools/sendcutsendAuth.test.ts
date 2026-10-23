// @vitest-environment node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { saveSendCutSendSession, SENDCUTSEND_SESSION_BOOTSTRAP } from "./sendcutsendAuth";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function outputPath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sendcutsend-auth-"));
  tempDirs.push(dir);
  return path.join(dir, "sendcutsend-storage-state.json");
}

const signedIn = {
  cookies: [
    { name: "session", value: "v", domain: "app.sendcutsend.com", path: "/" },
    { name: "ga", value: "v", domain: ".sendcutsend.com", path: "/" },
  ],
  origins: [{ origin: "https://app.sendcutsend.com", localStorage: [] }],
};

function page(status: number) {
  return {
    goto: vi.fn(async () => undefined),
    evaluate: vi.fn(async () => status) as unknown as <T>(fn: () => Promise<T>) => Promise<T>,
  };
}

describe("SendCutSend session save", () => {
  it("opens the quote page for a manual sign-in", () => {
    expect(SENDCUTSEND_SESSION_BOOTSTRAP).toMatchObject({
      vendor: "sendcutsend",
      loginUrl: "https://app.sendcutsend.com/customer#/quote",
    });
  });

  it("saves only exact-host entries, privately, once the app reports a signed-in user", async () => {
    const target = await outputPath();
    const lines: string[] = [];
    await saveSendCutSendSession({ storageState: async () => signedIn }, page(200), target, (line) => lines.push(line));
    const saved = JSON.parse(await fs.readFile(target, "utf8"));
    expect(saved.cookies).toEqual([signedIn.cookies[0]]);
    expect(saved.origins).toEqual(signedIn.origins);
    expect((await fs.stat(target)).mode & 0o777).toBe(0o600);
    expect(lines.join("\n")).toContain("Dropped cookies for: sendcutsend.com");
    expect(lines.join("\n")).not.toContain("v\"");
  });

  it.each([401, 0])("saves nothing when the app reports status %s", async (status) => {
    const target = await outputPath();
    await expect(saveSendCutSendSession({ storageState: async () => signedIn }, page(status), target, () => undefined))
      .rejects.toThrow(/did not report a signed-in user/);
    await expect(fs.stat(target)).rejects.toThrow();
  });

  it("saves nothing without an app cookie", async () => {
    const target = await outputPath();
    await expect(saveSendCutSendSession(
      { storageState: async () => ({ cookies: [signedIn.cookies[1]], origins: [] }) }, page(200), target, () => undefined,
    )).rejects.toThrow(/No SendCutSend app cookie/);
    await expect(fs.stat(target)).rejects.toThrow();
  });
});
