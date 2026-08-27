// @vitest-environment node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createOvd410RecoveryPhaseReporter,
  OVD410_RECOVERY_PHASES,
} from "./ovd410RecoveryPhase.js";

const temporaryDirectories: string[] = [];

async function fixture() {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "ovd410-recovery-phase-"),
  );
  temporaryDirectories.push(directory);
  await fs.chmod(directory, 0o700);
  const phasePath = path.join(directory, "last-stage");
  const reporter = await createOvd410RecoveryPhaseReporter({
    phasePath,
    expectedPath: phasePath,
    expectedUid: process.getuid?.() ?? 0,
  });
  return { directory, phasePath, reporter };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { force: true, recursive: true }),
    ),
  );
});

describe("OVD-410 recovery phase reporter", () => {
  it("writes the finite stages in order with atomic 0600 replacement", async () => {
    const { directory, phasePath, reporter } = await fixture();
    await fs.writeFile(phasePath, "container-start\n", { mode: 0o600 });

    for (const stage of OVD410_RECOVERY_PHASES.slice(2, 11)) {
      await reporter.write(stage);
    }

    expect(await fs.readFile(phasePath, "utf8")).toBe(
      "identity-promoted\n",
    );
    expect((await fs.stat(phasePath)).mode & 0o777).toBe(0o600);
    expect(await fs.readdir(directory)).toEqual(["last-stage"]);
  });

  it("rejects skipped, repeated, and non-allowlisted transitions", async () => {
    const { phasePath, reporter } = await fixture();
    await fs.writeFile(phasePath, "container-start\n", { mode: 0o600 });

    await expect(reporter.write("profile-ready")).rejects.toThrow(
      "transition is invalid",
    );
    await expect(reporter.write("container-start")).rejects.toThrow(
      "transition is invalid",
    );
    await expect(
      reporter.write("raw-provider-error" as never),
    ).rejects.toThrow("transition is invalid");
  });

  it.each([
    "provider-navigation\nextra\n",
    "provider-sensitive-content\n",
    "../owner/profile\n",
    "not-a-stage",
  ])("rejects hostile or malformed existing content", async (content) => {
    const { phasePath } = await fixture();
    await fs.writeFile(phasePath, content, { mode: 0o600 });
    const reporter = await createOvd410RecoveryPhaseReporter({
      phasePath,
      expectedPath: phasePath,
      expectedUid: process.getuid?.() ?? 0,
    });

    await expect(reporter.write("tool-start")).rejects.toThrow(
      "channel is invalid",
    );
  });

  it("rejects alternate paths and insecure channel metadata", async () => {
    const { directory, phasePath } = await fixture();
    await expect(
      createOvd410RecoveryPhaseReporter({
        phasePath,
        expectedPath: `${phasePath}-different`,
        expectedUid: process.getuid?.() ?? 0,
      }),
    ).rejects.toThrow("channel is invalid");

    await fs.chmod(directory, 0o755);
    await expect(
      createOvd410RecoveryPhaseReporter({
        phasePath,
        expectedPath: phasePath,
        expectedUid: process.getuid?.() ?? 0,
      }),
    ).rejects.toThrow("channel is invalid");
  });

  it("fails closed when the mounted channel becomes unwritable", async () => {
    const { directory, phasePath, reporter } = await fixture();
    await fs.writeFile(phasePath, "container-start\n", { mode: 0o600 });
    await fs.chmod(directory, 0o500);

    try {
      await expect(reporter.write("tool-start")).rejects.toThrow(
        "channel is invalid",
      );
    } finally {
      await fs.chmod(directory, 0o700);
    }
  });

  it("is a no-op when the recovery-only channel is not enabled", async () => {
    const reporter = await createOvd410RecoveryPhaseReporter({ phasePath: "" });
    expect(reporter.enabled).toBe(false);
    await expect(reporter.write("tool-start")).resolves.toBeUndefined();
  });
});
