import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeAppSchemaDump } from "./compare-ovd372-app-schema.mjs";
import {
  EXPECTED_OVD373_APP_SCHEMA_SHA256,
  hashOvd373AppSchema,
  verifyOvd373AppSchema,
} from "./verify-ovd373-schema-fingerprint.mjs";

describe("OVD-373 app-schema fingerprint verifier", () => {
  it("accepts schema contents through standard input instead of a caller-selected path", () => {
    const source = readFileSync(
      resolve(process.cwd(), "scripts/verify-ovd373-schema-fingerprint.mjs"),
      "utf8",
    );

    expect(source).toContain("for await (const chunk of process.stdin)");
    expect(source).not.toMatch(/\b(?:lstat|readFile)\(/);
    expect(source).not.toContain("path.resolve");
  });

  it("uses the exact production-derived post-push fingerprint", () => {
    expect(EXPECTED_OVD373_APP_SCHEMA_SHA256).toBe(
      "1197ed7b3794163bcfa558c464c065d6d27b2eba31d418fac054cbb3a0672552",
    );
  });

  it("uses the same restriction-token normalization as the OVD-372 comparator", () => {
    const schema = String.raw`\restrict random-token
CREATE TABLE public.example (id uuid);
\unrestrict random-token
`;

    expect(hashOvd373AppSchema(schema)).toBe(
      hashOvd373AppSchema(normalizeAppSchemaDump(schema)),
    );
  });

  it("fails closed when the schema does not match the qualified fingerprint", () => {
    expect(verifyOvd373AppSchema("CREATE TABLE public.unexpected (id uuid);\n")).toMatch(
      /^expected [0-9a-f]{64}, found [0-9a-f]{64}$/,
    );
  });
});
