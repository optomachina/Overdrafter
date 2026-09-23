import { describe, expect, it } from "vitest";
import { validateOvd419ResourceAnnotations } from "./ovd419-cloud-run-metadata-contract.mjs";
import { OVD410_PRODUCTION_CONTRACT as NETWORK } from "./xometry-stable-egress-contract.mjs";

const routing = {
  "run.googleapis.com/network-interfaces": JSON.stringify([{
    network: NETWORK.network, subnetwork: NETWORK.subnet,
  }]),
  "run.googleapis.com/vpc-access-egress": "all-traffic",
};

describe("Cloud Run resource annotation contract", () => {
  it("accepts the fixed network and server attribution only in the read-side mode", () => {
    expect(() => validateOvd419ResourceAnnotations({ ...routing }, { network: true })).not.toThrow();
    expect(() => validateOvd419ResourceAnnotations({ ...routing,
      "run.googleapis.com/creator": "TEST_ONLY_operator@example.invalid",
      "run.googleapis.com/lastModifier": "TEST_ONLY_operator@example.invalid",
    }, { network: true, allowServerAttribution: true })).not.toThrow();
  });

  it.each([
    ["server attribution without read-side mode", { ...routing,
      "run.googleapis.com/creator": "TEST_ONLY_operator@example.invalid" }, { network: true }],
    ["unknown server attribution", { ...routing,
      "run.googleapis.com/creator": "TEST_ONLY\noperator" }, { network: true, allowServerAttribution: true }],
    ["missing network", { "run.googleapis.com/vpc-access-egress": "all-traffic" }, { network: true }],
    ["wrong network", { ...routing,
      "run.googleapis.com/network-interfaces": JSON.stringify([{
        network: "other-network", subnetwork: NETWORK.subnet,
      }]) }, { network: true }],
    ["wrong egress", { ...routing, "run.googleapis.com/vpc-access-egress": "private-ranges-only" }, { network: true }],
  ])("rejects %s", (_, annotations, options) => {
    expect(() => validateOvd419ResourceAnnotations(annotations, options))
      .toThrow(/^cloud_run_metadata_contract_rejected$/);
  });
});
