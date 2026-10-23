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

function page(signedIn: boolean) {
  return {
    goto: vi.fn(async () => undefined),
    evaluate: vi.fn(async () => signedIn) as unknown as <T>(fn: () => Promise<T>) => Promise<T>,
  };
}

/** A headed session plus the fresh verification context built from the filtered state. */
function session(options: { signedIn?: boolean; survivesFilter?: boolean; state?: unknown } = {}) {
  const verificationContexts: unknown[] = [];
  const close = vi.fn(async () => undefined);
  const context = {
    storageState: async () => options.state ?? signedIn,
    newPage: async () => page(options.signedIn ?? true),
    close,
  };
  const browser = {
    newContext: vi.fn(async (contextOptions: { storageState: never }) => {
      verificationContexts.push(contextOptions.storageState);
      return { storageState: async () => ({}), newPage: async () => page(options.survivesFilter ?? true), close };
    }),
  };
  return { session: { browser, context, page: page(options.signedIn ?? true) }, verificationContexts, close };
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
    const { session: headed, verificationContexts, close } = session();
    await saveSendCutSendSession(headed, target, (line) => lines.push(line));
    expect(verificationContexts).toEqual([{ cookies: [signedIn.cookies[0]], origins: signedIn.origins }]);
    expect(close).toHaveBeenCalledOnce();
    const saved = JSON.parse(await fs.readFile(target, "utf8"));
    expect(saved.cookies).toEqual([signedIn.cookies[0]]);
    expect(saved.origins).toEqual(signedIn.origins);
    expect((await fs.stat(target)).mode & 0o777).toBe(0o600);
    expect(lines.join("\n")).toContain("Dropped cookies for: sendcutsend.com");
    expect(lines.join("\n")).not.toContain("v\"");
  });

  it("saves nothing when the app does not report a signed-in, non-guest user", async () => {
    const target = await outputPath();
    await expect(saveSendCutSendSession(session({ signedIn: false }).session, target, () => undefined))
      .rejects.toThrow(/did not report a signed-in user/);
    await expect(fs.stat(target)).rejects.toThrow();
  });

  it("saves nothing when the session does not survive the exact-host filter", async () => {
    const target = await outputPath();
    const { session: headed, close } = session({ survivesFilter: false });
    await expect(saveSendCutSendSession(headed, target, () => undefined))
      .rejects.toThrow(/does not survive the exact-host filter/);
    expect(close).toHaveBeenCalledOnce();
    await expect(fs.stat(target)).rejects.toThrow();
  });

  it("saves nothing without an app cookie", async () => {
    const target = await outputPath();
    await expect(saveSendCutSendSession(
      session({ state: { cookies: [signedIn.cookies[1]], origins: [] } }).session, target, () => undefined,
    )).rejects.toThrow(/No SendCutSend app cookie/);
    await expect(fs.stat(target)).rejects.toThrow();
  });
});
