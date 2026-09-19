import { unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  VERIFIER_AUTHORITY_ALLOWLIST,
  verifyVerifierAuthorityContract,
} from "./verify-verifier-authority-contract.mjs";

describe("native verifier authority contract", () => {
  it("pins the exact allowlist and keeps deployable authority absent", async () => {
    const result = await verifyVerifierAuthorityContract();

    expect(result).toEqual({
      contract: "docs/verifier-authority-contract.md",
      allowlist: [...VERIFIER_AUTHORITY_ALLOWLIST],
      deployableVerifierReferences: [],
      result: "pass",
    });
  });

  it("fails closed when verifier authority exists only in an untracked source file", async () => {
    const fixture = join(
      process.cwd(),
      "server",
      `ovd521-untracked-authority-${process.pid}.ts`,
    );
    await writeFile(fixture, "const role = 'engineering_native_verifier';\n", "utf8");

    try {
      await expect(verifyVerifierAuthorityContract()).rejects.toThrow(
        "current deployable source contains verifier authority",
      );
    } finally {
      await unlink(fixture);
    }
  });
});
