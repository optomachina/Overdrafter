// @vitest-environment node

import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { runVerifiedXometryCamoufoxRecovery } from "../xometryAuthRecovery.js";
import { createLockedXometryProfileArchive } from "../xometryProfileExport.js";

describe("Xometry auth tool orchestration contract", () => {
  it("executes load, invalidation, both closed browser proofs, and promotion in order", async () => {
    const events: string[] = [];
    const result = await runVerifiedXometryCamoufoxRecovery({
      loadRecoveryIdentity: async () => {
        events.push("load");
        return { fingerprint: "stable" };
      },
      invalidateIdentity: async () => {
        events.push("invalidate");
      },
      runInteractiveVerification: async (identity) => {
        expect(identity).toEqual({ fingerprint: "stable" });
        events.push("interactive-open");
        events.push("interactive-close");
        return {
          identity: { fingerprint: "stable" },
          url: "https://www.xometry.com/quoting/home/",
        };
      },
      runColdRelaunchProof: async (identity) => {
        expect(identity).toEqual({ fingerprint: "stable" });
        events.push("cold-open");
        events.push("cold-close");
        return {
          authenticated: true,
          reason: "authenticated_dashboard",
          url: "https://www.xometry.com/quoting/home/",
          blockedNonReadMethods: [],
          dashboardUploadButtonVisible: false,
          fileSelectionPerformed: false,
          userInputInteractionPerformed: false,
        };
      },
      promoteIdentity: async () => {
        events.push("promote");
      },
    });

    expect(events).toEqual([
      "load",
      "invalidate",
      "interactive-open",
      "interactive-close",
      "cold-open",
      "cold-close",
      "promote",
    ]);
    expect(result.coldEvidence.authenticated).toBe(true);
  });

  it.each(["interactive", "cold"])(
    "does not promote identity when %s verification fails",
    async (failureStage) => {
      const events: string[] = [];
      await expect(
        runVerifiedXometryCamoufoxRecovery({
          loadRecoveryIdentity: async () => ({ fingerprint: "stable" }),
          invalidateIdentity: async () => {
            events.push("invalidate");
          },
          runInteractiveVerification: async () => {
            events.push("interactive");
            if (failureStage === "interactive") throw new Error("failed");
            return {
              identity: { fingerprint: "stable" },
              url: "https://www.xometry.com/quoting/home/",
            };
          },
          runColdRelaunchProof: async () => {
            events.push("cold");
            throw new Error("failed");
          },
          promoteIdentity: async () => {
            events.push("promote");
          },
        }),
      ).rejects.toThrow("failed");
      expect(events).not.toContain("promote");
      expect(events[0]).toBe("invalidate");
    },
  );

  it("invalidates identity even when recovery loading fails", async () => {
    const events: string[] = [];
    await expect(
      runVerifiedXometryCamoufoxRecovery({
        loadRecoveryIdentity: async () => {
          throw new Error("load failed");
        },
        invalidateIdentity: async () => {
          events.push("invalidate");
        },
        runInteractiveVerification: async () => {
          throw new Error("must not run");
        },
        runColdRelaunchProof: async () => {
          throw new Error("must not run");
        },
        promoteIdentity: async () => {
          throw new Error("must not run");
        },
      }),
    ).rejects.toThrow("load failed");
    expect(events).toEqual(["invalidate"]);
  });

  it("uses offline-first launch contracts for both hosted probe engines", async () => {
    const source = await fs.readFile(
      new URL("./probeXometryProfileAuth.ts", import.meta.url),
      "utf8",
    );

    expect(source).toContain(
      "launchOverrides: XOMETRY_AUTH_PROBE_CAMOUFOX_NETWORK_GUARDS",
    );
    expect(source).toContain("...XOMETRY_AUTH_PROBE_PLAYWRIGHT_CONTEXT_GUARDS");
  });

  it("holds the profile lifecycle lock through archive creation", async () => {
    const events: string[] = [];

    await createLockedXometryProfileArchive(
      {
        userDataDir: "/tmp/xometry-profile",
        browserEngine: "camoufox",
        outputPath: "/tmp/xometry-profile.tgz",
      },
      {
        withProfileLock: async (_userDataDir, _options, operation) => {
          events.push("lock-enter");
          await operation();
          events.push("lock-exit");
        },
        createArchive: async () => {
          events.push("archive");
        },
      },
    );

    expect(events).toEqual(["lock-enter", "archive", "lock-exit"]);
  });
});
