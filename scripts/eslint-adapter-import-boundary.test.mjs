// @vitest-environment node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const eslint = new ESLint({ cwd: repoRoot, overrideConfigFile: path.join(repoRoot, "eslint.config.js") });

async function boundaryMessages(code, relativePath) {
  const [result] = await eslint.lintText(code, { filePath: path.join(repoRoot, relativePath) });
  return result.messages.filter((message) =>
    ["@typescript-eslint/no-restricted-imports", "no-restricted-imports", "no-restricted-syntax"].includes(
      message.ruleId,
    ),
  );
}

describe("OVD-874 adapter import boundary", () => {
  it("warns on a direct adapter import from a route file", async () => {
    const messages = await boundaryMessages(
      'import { XometryAdapter } from "../../worker/src/adapters/xometry.js";\nexport const adapter = XometryAdapter;\n',
      "api/quotes/fixture-route.ts",
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ ruleId: "@typescript-eslint/no-restricted-imports", severity: 1 });
  });

  it("warns on a direct adapter import from a non-allowlisted worker module", async () => {
    const messages = await boundaryMessages(
      'import { buildAdapterRegistry } from "./adapters/index.js";\nexport const registry = buildAdapterRegistry;\n',
      "worker/src/fixtureRoute.ts",
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].severity).toBe(1);
  });

  it("warns on a direct adapter import from a plain JS module", async () => {
    const messages = await boundaryMessages(
      'import { buildAdapterRegistry } from "../worker/src/adapters/index.js";\nexport const registry = buildAdapterRegistry;\n',
      "scripts/fixture-route.mjs",
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ ruleId: "no-restricted-imports", severity: 1 });
  });

  it("allows adapter imports from the dispatch module", async () => {
    const messages = await boundaryMessages(
      'import { buildAdapterRegistry } from "./adapters/index.js";\nexport const registry = buildAdapterRegistry;\n',
      "worker/src/index.ts",
    );
    expect(messages).toEqual([]);
  });

  it("allows type-only adapter imports anywhere", async () => {
    const messages = await boundaryMessages(
      'import type { VendorAdapter } from "../../worker/src/adapters/base.js";\nexport type Adapter = VendorAdapter;\n',
      "api/quotes/fixture-route.ts",
    );
    expect(messages).toEqual([]);
  });

  it("warns on a CertifiedProviderId cast", async () => {
    const messages = await boundaryMessages(
      'type CertifiedProviderId = string & { readonly __brand: "certified" };\nexport const id = "xometry" as CertifiedProviderId;\n',
      "worker/src/index.ts",
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ ruleId: "no-restricted-syntax", severity: 1 });
  });
});
