import fixture from "../../test-fixtures/provider-dispatch-envelope/quickparts-v1.json";
import type { ProviderDispatchEnvelope } from "../src/providerDispatchEnvelope.js";
import type { ProviderDispatchAuthorization } from "../src/providerDispatchTypes.js";
import { buildProviderDispatchFixtureEnvelope, providerDispatchFixtureAuthorization } from "./providerDispatchFixture.js";

/** Synthetic Quickparts envelope fixture (OVD-674): one CAD file, no drawing. No provider, account, or customer data. */
export function quickpartsDispatchEnvelope(binding: {
  cadSha256: string;
  requestedQuantity: number;
}): ProviderDispatchEnvelope {
  return buildProviderDispatchFixtureEnvelope("Quickparts", fixture.envelope, binding);
}

export function quickpartsDispatchAuthorization(envelope: ProviderDispatchEnvelope): ProviderDispatchAuthorization {
  return providerDispatchFixtureAuthorization(envelope);
}
