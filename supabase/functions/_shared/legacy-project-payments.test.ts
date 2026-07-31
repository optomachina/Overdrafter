import { assertEquals } from "https://deno.land/std@0.220.0/assert/mod.ts";
import { isLegacyProjectPaymentsEnabled } from "./legacy-project-payments.ts";

Deno.test("legacy payment flag accepts only normalized true", () => {
  assertEquals(isLegacyProjectPaymentsEnabled("true"), true);
  assertEquals(isLegacyProjectPaymentsEnabled(" TRUE "), true);
  assertEquals(isLegacyProjectPaymentsEnabled("TrUe"), true);
  assertEquals(isLegacyProjectPaymentsEnabled(undefined), false);
  assertEquals(isLegacyProjectPaymentsEnabled(""), false);
  assertEquals(isLegacyProjectPaymentsEnabled("false"), false);
  assertEquals(isLegacyProjectPaymentsEnabled("1"), false);
  assertEquals(isLegacyProjectPaymentsEnabled("yes"), false);
});
