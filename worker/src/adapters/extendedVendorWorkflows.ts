import { PortalQuoteWorkflowAdapter, type PortalQuoteWorkflow } from "./portalWorkflow.js";
import type { LiveAutomationVendorName, VendorName, WorkerConfig } from "../types.js";

export const EXTENDED_VENDOR_WORKFLOWS = [
  {
    vendor: "oshcut",
    displayName: "OSH Cut",
    source: "oshcut-live-adapter",
    publicUrl: "https://www.oshcut.com/online-metal-fabrication/",
    loginUrl: "https://app.oshcut.com/login",
    uploadUrl: "https://app.oshcut.com/",
    processFamily: "sheet_metal",
    supportedFileExtensions: ["dxf", "svg", "ai", "step", "stp", "sldprt", "igs", "iges"],
    officialNotes: [
      "Official site advertises instant laser cutting and bending prices.",
      "Official site lists 2D and 3D upload formats including DXF, SVG, STEP, and IGES.",
    ],
  },
  {
    vendor: "fabworks",
    displayName: "Fabworks",
    source: "fabworks-live-adapter",
    publicUrl: "https://www.fabworks.com/",
    loginUrl: "https://www.fabworks.com/signin",
    uploadUrl: "https://www.fabworks.com/",
    processFamily: "sheet_metal",
    supportedFileExtensions: ["step", "stp"],
    officialNotes: [
      "Official site advertises STEP/STP upload for instant laser cutting quotes.",
      "Official site says users can configure services in a 3D viewer and pay in-platform.",
    ],
  },
  {
    vendor: "ponoko",
    displayName: "Ponoko",
    source: "ponoko-live-adapter",
    publicUrl: "https://www.ponoko.com/",
    loginUrl: "https://www.ponoko.com/",
    uploadUrl: "https://www.ponoko.com/",
    processFamily: "sheet_metal",
    supportedFileExtensions: ["ai", "dxf", "eps", "svg", "pdf", "step", "stp", "stl"],
    officialNotes: [
      "Official site advertises online quotes in seconds for laser-cut parts.",
      "Official site lists broad 2D and 3D upload formats and automated DFM feedback.",
    ],
  },
  {
    vendor: "quickparts",
    displayName: "Quickparts",
    source: "quickparts-live-adapter",
    publicUrl: "https://quickparts.com/",
    loginUrl: "https://quickquote.quickparts.com/#/login",
    uploadUrl: "https://quickquote.quickparts.com/",
    processFamily: "multi_process",
    supportedFileExtensions: ["step", "stp", "igs", "iges", "sldprt", "stl"],
    officialNotes: [
      "Quickparts QuickQuote is the official instant quoting surface.",
      "Public materials describe CNC, 3D printing, injection molding, urethane casting, and sheet metal coverage.",
    ],
  },
  {
    vendor: "rapiddirect",
    displayName: "RapidDirect",
    source: "rapiddirect-live-adapter",
    publicUrl: "https://www.rapiddirect.com/",
    loginUrl: "https://app.rapiddirect.com/member/login",
    uploadUrl: "https://app.rapiddirect.com/",
    processFamily: "multi_process",
    supportedFileExtensions: ["step", "stp", "igs", "iges", "prt", "sldprt", "sat", "x_t"],
    officialNotes: [
      "Official site advertises instant pricing and DFM for CNC, sheet metal, and 3D printing.",
      "Official platform page lists STEP, STP, IGS, IGES, PRT, SLDPRT, SAT, and X_T uploads.",
    ],
  },
  {
    vendor: "geomiq",
    displayName: "Geomiq",
    source: "geomiq-live-adapter",
    publicUrl: "https://geomiq.com/",
    loginUrl: "https://app.geomiq.com/",
    uploadUrl: "https://app.geomiq.com/",
    processFamily: "multi_process",
    supportedFileExtensions: ["step", "stp", "iges", "igs", "stl"],
    officialNotes: [
      "Official site advertises instant or 24-hour CNC quotes.",
      "Official platform page covers CNC, injection molding, sheet metal, and 3D printing.",
    ],
  },
  {
    vendor: "weerg",
    displayName: "Weerg",
    source: "weerg-live-adapter",
    publicUrl: "https://www.weerg.com/",
    loginUrl: "https://www.weerg.com/",
    uploadUrl: "https://www.weerg.com/en/global/quotation-tool/upload",
    processFamily: "multi_process",
    supportedFileExtensions: ["step", "stp", "stl", "iges", "igs"],
    officialNotes: [
      "Official site advertises free online instant quotes.",
      "Official site covers CNC machining, 3D printing, and laser cutting.",
    ],
  },
  {
    vendor: "protolabsnetwork",
    displayName: "Protolabs Network",
    source: "protolabsnetwork-live-adapter",
    publicUrl: "https://www.hubs.com/",
    loginUrl: "https://www.hubs.com/login/",
    uploadUrl: "https://www.hubs.com/manufacture/",
    processFamily: "multi_process",
    supportedFileExtensions: ["step", "stp", "stl", "iges", "igs", "sldprt"],
    officialNotes: [
      "Official Protolabs Network site advertises instant quote upload for CNC, 3D printing, and sheet metal.",
      "Protolabs Network is the Hubs on-demand manufacturing network under Protolabs.",
    ],
  },
] as const satisfies readonly PortalQuoteWorkflow[];

export type ExtendedLiveVendorName = (typeof EXTENDED_VENDOR_WORKFLOWS)[number]["vendor"];

const EXTENDED_VENDOR_WORKFLOW_MAP = new Map<LiveAutomationVendorName, PortalQuoteWorkflow>(
  EXTENDED_VENDOR_WORKFLOWS.map((workflow) => [workflow.vendor, workflow]),
);

export function buildExtendedVendorAdapters(
  config: WorkerConfig,
): Partial<Record<VendorName, PortalQuoteWorkflowAdapter>> {
  return Object.fromEntries(
    EXTENDED_VENDOR_WORKFLOWS.map((workflow) => [
      workflow.vendor,
      new PortalQuoteWorkflowAdapter(workflow.vendor, config, workflow),
    ]),
  );
}

export function getExtendedVendorWorkflow(
  vendor: string,
): PortalQuoteWorkflow | null {
  return EXTENDED_VENDOR_WORKFLOW_MAP.get(vendor as LiveAutomationVendorName) ?? null;
}
