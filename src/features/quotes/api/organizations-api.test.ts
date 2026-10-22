import { beforeEach, describe, expect, it, vi } from "vitest";

const rpcMock = vi.hoisted(() => vi.fn());
vi.mock("./shared/rpc", () => ({ callUntypedRpc: rpcMock }));

import { confirmSourcingDestination, isSourcingAddressComplete, missingSourcingAddressFields } from "./organizations-api";

const address = { street: "123 Test Ave", city: "Tucson", region: "AZ", postalCode: "85701", country: "US" };

beforeEach(() => rpcMock.mockReset());

describe("sourcing address completeness", () => {
  it("names the missing fields for a country-only US address", () => {
    const incomplete = { street: null, city: null, region: null, postalCode: null, country: "US" };
    expect(missingSourcingAddressFields(incomplete)).toEqual(["street", "city", "ZIP", "state"]);
    expect(isSourcingAddressComplete(incomplete)).toBe(false);
  });

  it.each(["street", "city", "region", "postalCode", "country"] as const)("rejects blank %s", (field) => {
    expect(isSourcingAddressComplete({ ...address, [field]: "   " })).toBe(false);
  });

  it("requires a region only for US addresses", () => {
    expect(isSourcingAddressComplete(address)).toBe(true);
    expect(missingSourcingAddressFields(address)).toEqual([]);
    expect(isSourcingAddressComplete({ ...address, country: "GB", region: null })).toBe(true);
  });
});

describe("confirmSourcingDestination", () => {
  it("names required fields for an incomplete destination without suggesting a reload", async () => {
    rpcMock.mockResolvedValue({ error: { message: "sourcing_destination_incomplete" } });
    const result = confirmSourcingDestination("org-1", address);
    await expect(result).rejects.toThrow(/street, city, ZIP/);
    await expect(result).rejects.toThrow(/state/);
    await expect(result).rejects.not.toThrow(/Reload/);
  });

  it("asks to reload when the destination changed", async () => {
    rpcMock.mockResolvedValue({ error: { message: "sourcing_destination_changed" } });
    await expect(confirmSourcingDestination("org-1", address)).rejects.toThrow("The shipping address changed. Reload and confirm the current address.");
  });

  it("uses a generic message for other failures", async () => {
    rpcMock.mockResolvedValue({ error: { message: "access_denied" } });
    await expect(confirmSourcingDestination("org-1", address)).rejects.toThrow("Could not confirm the shipping address. Please try again.");
  });

  it("confirms the exact address through the RPC", async () => {
    rpcMock.mockResolvedValue({ error: null });
    await expect(confirmSourcingDestination("org-1", address)).resolves.toBeUndefined();
    expect(rpcMock).toHaveBeenCalledWith("api_confirm_sourcing_destination", {
      p_organization_id: "org-1", p_expected_address: address,
    });
  });
});
