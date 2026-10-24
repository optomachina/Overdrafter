/** Shared adversarial inputs: both entry points must return the same rejection. */
import type { LocatorPackRejection } from "../src/fixtureHeal/locatorPackValidation.js";
type Edit = { path: string; value?: unknown; remove?: boolean };
export const malformedLocatorPackCases: { name: string; provider?: string; edits: Edit[]; reason: LocatorPackRejection }[] = [
  { name: "wrong schema", edits: [{ path: "schema", value: "other" }], reason: "locator_pack_schema_invalid" },
  { name: "unknown top-level key", edits: [{ path: "unknown", value: true }], reason: "locator_pack_schema_invalid" },
  { name: "missing cadUpload", edits: [{ path: "selectors.cadUpload", remove: true }], reason: "locator_pack_schema_invalid" },
  { name: "dangling selector reference", edits: [{ path: "flow.2.selector", value: "missing" }], reason: "locator_pack_reference_unknown" },
  { name: "unknown labels map", edits: [{ path: "flow.2.value", value: "labels.missing[x]" }], reason: "locator_pack_reference_unknown" },
  { name: "unknown route", edits: [{ path: "flow.0.route", value: "other" }], reason: "locator_pack_route_invalid" },
  { name: "non-https route", edits: [{ path: "routes.publicUrl", value: "http://quickparts.com/" }], reason: "locator_pack_route_invalid" },
  { name: "route host outside allowedHosts", edits: [{ path: "routes.publicUrl", value: "https://example.com/" }], reason: "locator_pack_route_invalid" },
  { name: "wildcard host", edits: [{ path: "allowedHosts", value: ["*.quickparts.com"] }], reason: "locator_pack_host_invalid" },
  { name: "overlapping offHost host", edits: [{ path: "offHostAllowlist", value: ["quickparts.com"] }], reason: "locator_pack_host_invalid" },
  { name: "stateful signal", edits: [{ path: "terminalSignals.login.0.flags", value: "g" }], reason: "locator_pack_signal_invalid" },
  { name: "non-compiling signal", edits: [{ path: "terminalSignals.login.0.pattern", value: "[" }], reason: "locator_pack_signal_invalid" },
  { name: "prohibited configuration", provider: "weerg", edits: [{ path: "selectors.material", value: ".cart" }], reason: "locator_pack_configuration_prohibited" },
  { name: "two uploads", edits: [{ path: "flow.2", value: { op: "upload", selector: "cadUpload" } }], reason: "locator_pack_schema_invalid" },
  { name: "two price readers", edits: [{ path: "flow.2", value: { op: "readPrice", unit: "quantity", total: "quantity" } }], reason: "locator_pack_schema_invalid" },
  { name: "reportOnly clicking rule", provider: "oshcut", edits: [{ path: "cleanup.rules.partRow.reportOnly", value: false }], reason: "locator_pack_schema_invalid" },
  { name: "revision provider mismatch", edits: [{ path: "revision", value: "other-production-locators.v1" }], reason: "locator_pack_provider_mismatch" },
  { name: "kernel mismatch", edits: [{ path: "kernelRevision", value: "provider-portal-kernel.v2" }], reason: "locator_pack_schema_invalid" },
  { name: "extra flow key", edits: [{ path: "flow.0.extra", value: true }], reason: "locator_pack_schema_invalid" },
  { name: "unknown op", edits: [{ path: "flow.2.op", value: "execute" }], reason: "locator_pack_flow_op_unknown" },
  { name: "signal flags out of order", edits: [{ path: "terminalSignals.login.0.flags", value: "mi" }], reason: "locator_pack_signal_invalid" },
  { name: "explicit default port", edits: [{ path: "routes.publicUrl", value: "https://quickparts.com:443/" }], reason: "locator_pack_route_invalid" },
  { name: "route credentials", edits: [{ path: "routes.publicUrl", value: "https://name@quickparts.com/" }], reason: "locator_pack_route_invalid" },
  { name: "duplicate host", edits: [{ path: "allowedHosts", value: ["quickparts.com", "quickparts.com"] }], reason: "locator_pack_host_invalid" },
  { name: "control character", edits: [{ path: "selectors.cadUpload", value: "input\n" }], reason: "locator_pack_schema_invalid" },
  { name: "timeout too large", provider: "oshcut", edits: [{ path: "flow.6.timeoutMs", value: 120001 }], reason: "locator_pack_schema_invalid" },
  { name: "reportOnly steps", provider: "oshcut", edits: [{ path: "cleanup.steps", value: [] }], reason: "locator_pack_schema_invalid" },
  { name: "dangling fingerprint", edits: [{ path: "fingerprint", value: { login: { readySelector: "missing" } } }], reason: "locator_pack_reference_unknown" },
  { name: "operation conflict", provider: "weerg", edits: [{ path: "flow.5", value: { op: "click", selector: "material" } }], reason: "locator_pack_schema_invalid" },
];
export function applyLocatorPackEdits(pack: unknown, edits: Edit[]): unknown {
  const result = structuredClone(pack) as Record<string, unknown>;
  for (const edit of edits) {
    const keys = edit.path.split(".");
    let target = result;
    for (const key of keys.slice(0, -1)) target = target[key] as Record<string, unknown>;
    const key = keys.at(-1)!;
    if (edit.remove) delete target[key]; else target[key] = edit.value;
  }
  return result;
}
