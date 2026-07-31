import { assertEquals } from "https://deno.land/std@0.220.0/assert/mod.ts";
import { isLegacyProjectPaymentsEnabled } from "./legacy-project-payments.ts";

Deno.test("legacy payment flag accepts normalized true", () => {
  assertEquals(isLegacyProjectPaymentsEnabled("true"), true);
  assertEquals(isLegacyProjectPaymentsEnabled(" TRUE "), true);
  assertEquals(isLegacyProjectPaymentsEnabled("TrUe"), true);
});

Deno.test("legacy payment flag rejects absent and non-true values", () => {
  assertEquals(isLegacyProjectPaymentsEnabled(undefined), false);
  assertEquals(isLegacyProjectPaymentsEnabled(""), false);
  assertEquals(isLegacyProjectPaymentsEnabled("false"), false);
  assertEquals(isLegacyProjectPaymentsEnabled("1"), false);
  assertEquals(isLegacyProjectPaymentsEnabled("yes"), false);
});
