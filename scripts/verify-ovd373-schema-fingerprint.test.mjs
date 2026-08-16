import { describe, expect, it } from "vitest";
import { normalizeAppSchemaDump } from "./compare-ovd372-app-schema.mjs";
import {
  EXPECTED_OVD373_APP_SCHEMA_SHA256,
  hashOvd373AppSchema,
  verifyOvd373AppSchema,
} from "./verify-ovd373-schema-fingerprint.mjs";

describe("OVD-373 app-schema fingerprint verifier", () => {
  it("uses the qualified OVD-372 fingerprint", () => {
    expect(EXPECTED_OVD373_APP_SCHEMA_SHA256).toBe(
      "fee2fd099b1237e90059fb44c1e2ca42d63343677bada9a75a16a6f8a38791e8",
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
