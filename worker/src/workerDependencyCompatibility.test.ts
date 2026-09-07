// @vitest-environment node
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);

describe("patched worker dependency compatibility", () => {
  it("reads bundled fingerprint networks and generates the existing Firefox profile", async () => {
    const { generateFingerprint } = await import("camoufox-js/dist/fingerprints.js");
    const fingerprint = generateFingerprint(undefined, { operatingSystems: ["linux"] });
    expect(fingerprint.navigator.userAgent).toContain("Firefox/");
    expect(fingerprint.navigator.userAgent).toContain("Linux");
    expect(fingerprint.screen.width).toBeGreaterThan(0);
  });

  it("preserves the ZIP extraction API used for bundled browser assets", async () => {
    const AdmZip = require("adm-zip");
    const directory = await mkdtemp(path.join(os.tmpdir(), "ovd419-zip-compat-"));
    try {
      const archive = new AdmZip();
      archive.addFile("fixture/version.json", Buffer.from('{"version":"offline"}'));
      const archivePath = path.join(directory, "fixture.zip");
      archive.writeZip(archivePath);
      const reopened = new AdmZip(archivePath);
      expect(reopened.getEntries()[0].getData().toString()).toBe('{"version":"offline"}');
      reopened.extractAllTo(path.join(directory, "output"), true);
      expect(await readFile(path.join(directory, "output/fixture/version.json"), "utf8"))
        .toBe('{"version":"offline"}');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("preserves the messages API with a local response and no provider connection", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      id: "msg_offline", type: "message", role: "assistant", model: "offline-model",
      content: [{ type: "text", text: "offline response" }],
      stop_reason: "end_turn", stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 2 },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const client = new Anthropic({ apiKey: "offline-test-only", fetch });
    const result = await client.messages.create({
      model: "offline-model", max_tokens: 8,
      messages: [{ role: "user", content: "synthetic input" }],
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(result.content).toEqual([{ type: "text", text: "offline response" }]);
  });
});
