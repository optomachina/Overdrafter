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

  it.each([
    ["public RPC", "const rpc = 'api_load_native_verification';\n"],
    ["private function", "const helper = 'complete_native_verification';\n"],
    ["uppercase SQL", "GRANT EXECUTE TO ENGINEERING_NATIVE_VERIFIER;\n"],
  ])("fails closed on untracked %s authority", async (label, source) => {
    const fixture = join(
      process.cwd(),
      "server",
      `ovd521-untracked-${label.replaceAll(" ", "-")}-${process.pid}.ts`,
    );
    await writeFile(fixture, source, "utf8");

    try {
      await expect(verifyVerifierAuthorityContract()).rejects.toThrow(
        "current deployable source contains verifier authority",
      );
    } finally {
      await unlink(fixture);
    }
  });
});
