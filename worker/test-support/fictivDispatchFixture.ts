import fixture from "../../test-fixtures/provider-dispatch-envelope/fictiv-v1.json";
import type { ProviderDispatchEnvelope } from "../src/providerDispatchEnvelope.js";
import type { ProviderDispatchAuthorization } from "../src/providerDispatchTypes.js";
import {
  buildProviderDispatchFixtureEnvelope,
  providerDispatchFixtureAuthorization,
  type ProviderDispatchFixtureBinding,
} from "./providerDispatchFixture.js";

/** Synthetic Fictiv envelope fixture (OVD-673). No provider, account, or customer data. */
export function fictivDispatchEnvelope(binding: ProviderDispatchFixtureBinding): ProviderDispatchEnvelope {
  return buildProviderDispatchFixtureEnvelope("Fictiv", fixture.envelope, binding);
}

export function fictivDispatchAuthorization(envelope: ProviderDispatchEnvelope): ProviderDispatchAuthorization {
  return providerDispatchFixtureAuthorization(envelope);
}
