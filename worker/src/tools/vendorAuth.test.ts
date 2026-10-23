// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { getExtendedVendorWorkflow } from "../adapters/extendedVendorWorkflows";
import { buildGeomiqProductionPortalDefinition } from "../adapters/geomiqProductionPortal";
import { buildPortalWorkflowDefinition } from "../adapters/portalWorkflow";
import { resolveIsolatedProviderStorageState } from "../adapters/providerPortalKernel";
import { buildQuickpartsProductionPortalDefinition } from "../adapters/quickpartsPortal";
import { buildWeergProductionPortalDefinition } from "../adapters/weergPortal";
import type { WorkerConfig } from "../types";
import { bootstrapVendor, parseAuthArgs, scopeStorageStateToHosts, sessionHostsFor } from "./vendorAuth";

afterEach(() => vi.restoreAllMocks());

const workflow = (vendor: string) => getExtendedVendorWorkflow(vendor)!;
const cookie = (domain: string, name = "c") => ({
  name, value: "synthetic", domain, path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" as const,
});
const origin = (value: string) => ({ origin: value, localStorage: [{ name: "k", value: "synthetic" }] });

describe("vendorAuth session scoping (OVD-1059)", () => {
  const captured = {
    cookies: [
      cookie(".quickparts.com", "root"),
      cookie(".quickquote.quickparts.com", "app"),
      cookie("quickquote.quickparts.com", "hostOnly"),
      cookie(".bing.com"),
      cookie("www.google.com"),
      cookie(".evil.quickparts.com"),
    ],
    origins: [
      origin("https://quickquote.quickparts.com"),
      origin("https://www.google.com"),
      origin("http://quickquote.quickparts.com"),
      origin("https://quickquote.quickparts.com:8443"),
    ],
  };

  it("keeps only cookies and origins on the provider's exact hosts", () => {
    const scoped = scopeStorageStateToHosts(captured, sessionHostsFor(workflow("quickparts")));
    expect(scoped.cookies.map((entry) => entry.name)).toEqual(["root", "app", "hostOnly"]);
    expect(scoped.origins.map((entry) => entry.origin)).toEqual(["https://quickquote.quickparts.com"]);
  });

  it("produces a session the portal kernel opens, where the raw capture is refused", async () => {
    const definition = buildQuickpartsProductionPortalDefinition();
    const open = (state: unknown) => resolveIsolatedProviderStorageState(definition, {
      vendorStorageStateJson: { quickparts: JSON.stringify(state) },
    } as unknown as WorkerConfig);
    await expect(open(captured)).resolves.toBeNull();
    await expect(open(scopeStorageStateToHosts(captured, sessionHostsFor(workflow("quickparts")))))
      .resolves.not.toBeNull();
  });

  it("uses each reviewed production definition's hosts, else the workflow's own", () => {
    expect(sessionHostsFor(workflow("quickparts"))).toEqual(buildQuickpartsProductionPortalDefinition().allowedHosts);
    expect(sessionHostsFor(workflow("geomiq"))).toEqual(buildGeomiqProductionPortalDefinition().allowedHosts);
    expect(sessionHostsFor(workflow("weerg"))).toEqual(buildWeergProductionPortalDefinition().allowedHosts);
    expect(sessionHostsFor(workflow("oshcut"))).toEqual(["app.oshcut.com"]);
    expect(sessionHostsFor(workflow("fabworks")))
      .toEqual(buildPortalWorkflowDefinition(workflow("fabworks")).allowedHosts);
  });
});

describe("vendorAuth argument parsing", () => {
  it("parses a single hidden vendor", () => {
    expect(parseAuthArgs(["OSHCut"])).toMatchObject({
      vendors: ["oshcut"],
      explicitOutputPath: null,
    });
  });

  it("skips the disabled portal and logs a notice for all", () => {
    const notice = vi.spyOn(console, "info").mockImplementation(() => undefined);
    expect(parseAuthArgs(["all"]).vendors).toEqual([
      "fabworks",
      "ponoko",
      "quickparts",
      "rapiddirect",
      "geomiq",
      "weerg",
      "protolabsnetwork",
    ]);
    expect(notice).toHaveBeenCalledWith(expect.stringMatching(/Skipping oshcut:.*disabled/));
  });

  it("parses a comma-separated hidden vendor subset", () => {
    expect(parseAuthArgs(["oshcut,quickparts,weerg"]).vendors).toEqual(["quickparts", "weerg"]);
  });

  it("refuses a single OSH Cut request before accessing session configuration", async () => {
    const args = parseAuthArgs(["oshcut"]);
    await expect(bootstrapVendor(args.vendors[0], args.explicitOutputPath))
      .rejects.toThrow(/OSH Cut portal automation is disabled.*OVD-1022/);
  });

  it("rejects unsupported vendors", () => {
    expect(() => parseAuthArgs(["oshcut,unknown"])).toThrow(/unsupported vendor/i);
  });

  it("rejects explicit output paths for batch auth", () => {
    expect(() => parseAuthArgs(["oshcut,quickparts,weerg", "./state.json"])).toThrow(/only supported for a single vendor/i);
  });
});
