import fixture from "../../test-fixtures/provider-dispatch-envelope/weerg-v1.json";
import type { ProviderDispatchEnvelope } from "../src/providerDispatchEnvelope.js";
import type { ProviderDispatchAuthorization } from "../src/providerDispatchTypes.js";
import { buildProviderDispatchFixtureEnvelope, providerDispatchFixtureAuthorization } from "./providerDispatchFixture.js";

/** Synthetic Weerg envelope fixture (OVD-675): one CAD file, no drawing. No provider, account, or customer data. */
export function weergDispatchEnvelope(binding: {
  cadSha256: string;
  requestedQuantity: number;
}): ProviderDispatchEnvelope {
  return buildProviderDispatchFixtureEnvelope("Weerg", fixture.envelope, binding);
}

export function weergDispatchAuthorization(envelope: ProviderDispatchEnvelope): ProviderDispatchAuthorization {
  return providerDispatchFixtureAuthorization(envelope);
}
