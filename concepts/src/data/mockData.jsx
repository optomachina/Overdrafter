// Shared mock data for all 5 concept page sets

export const currentUser = {
  name: "Blaine Wilson",
  email: "blaine@optomachina.com",
  initials: "BW",
};

export const mockProjects = [
  { id: "proj-1", name: "FLT Drone Frame Assembly", partCount: 12, updatedAt: "2h ago", status: "active" },
  { id: "proj-2", name: "Q1 2026 Intake Batch", partCount: 7, updatedAt: "1d ago", status: "active" },
  { id: "proj-3", name: "Heat Sink Redesign", partCount: 4, updatedAt: "3d ago", status: "active" },
  { id: "proj-4", name: "Opto Housing Rev3", partCount: 22, updatedAt: "1w ago", status: "archived" },
];

export const mockParts = [
  {
    id: "part-1",
    name: "FLT-BRACKET-01",
    description: "Main frame bracket, 6061-T6",
    rev: "Rev C",
    material: "6061-T6 Aluminum",
    finish: "Clear Anodize Type II",
    qty: 25,
    status: "received",
    quotePrice: "$487",
    leadTime: "12 bd",
    vendor: "Xometry",
    selected: true,
    updatedAt: "2h ago",
  },
  {
    id: "part-2",
    name: "FLT-MOTOR-MOUNT-02",
    description: "Motor mount plate,Delrin",
    rev: "Rev A",
    material: "Delrin (Acetal)",
    finish: "Natural",
    qty: 50,
    status: "requesting",
    quotePrice: null,
    leadTime: null,
    vendor: "Xometry",
    selected: false,
    updatedAt: "45m ago",
  },
  {
    id: "part-3",
    name: "FLT-SPINDLE-HUB",
    description: "Spindle hub, 7075-T651",
    rev: "Rev B",
    material: "7075-T651 Aluminum",
    finish: "Hard anodize",
    qty: 10,
    status: "not_requested",
    quotePrice: null,
    leadTime: null,
    vendor: null,
    selected: false,
    updatedAt: "3h ago",
  },
  {
    id: "part-4",
    name: "FLT-ARM-LEFT",
    description: "Left arm, carbon fiber",
    rev: "Rev A",
    material: "CF laminate",
    finish: "Matte clear",
    qty: 8,
    status: "received",
    quotePrice: "$312",
    leadTime: "7 bd",
    vendor: "CNC Masters",
    selected: false,
    updatedAt: "1d ago",
  },
  {
    id: "part-5",
    name: "FLT-ARM-RIGHT",
    description: "Right arm, carbon fiber",
    rev: "Rev A",
    material: "CF laminate",
    finish: "Matte clear",
    qty: 8,
    status: "failed",
    quotePrice: null,
    leadTime: null,
    vendor: "Xometry",
    selected: false,
    updatedAt: "1d ago",
  },
];

export const mockActivity = [
  { id: "act-1", type: "quote_received", actor: "Xometry", part: "FLT-BRACKET-01", time: "2h ago", detail: "3 options returned" },
  { id: "act-2", type: "part_uploaded", actor: "Blaine", part: "FLT-SPINDLE-HUB", time: "3h ago", detail: "STEP + PDF matched" },
  { id: "act-3", type: "quote_selected", actor: "Blaine", part: "FLT-BRACKET-01", time: "1d ago", detail: "$487 — Xometry selected" },
  { id: "act-4", type: "project_created", actor: "Blaine", part: null, time: "2d ago", detail: "FLT Drone Frame Assembly" },
  { id: "act-5", type: "quote_failed", actor: "Xometry", part: "FLT-ARM-RIGHT", time: "1d ago", detail: "Timeout — retry available" },
];

export const mockQuoteStats = {
  requesting: 1,
  received: 2,
  notRequested: 1,
  failed: 1,
};

export const mockPartDetail = {
  id: "part-1",
  name: "FLT-BRACKET-01",
  description: "Main frame bracket for drone assembly, dual-side mount configuration",
  rev: "Rev C",
  partNumber: "FLT-001-C",
  material: "6061-T6 Aluminum",
  finish: "Clear Anodize Type II",
  tolerance: "±0.005 in",
  quantity: 25,
  project: "FLT Drone Frame Assembly",
  created: "Mar 18, 2026",
  status: "received",
  drawingFile: "FLT-BRACKET-01.pdf",
  cadFile: "FLT-BRACKET-01.step",
  certifications: ["AS9100", "ISO 9001"],
  selectedOffer: {
    vendor: "Xometry",
    price: 487,
    leadTime: 12,
    process: "CNC Machining",
    certifications: "AS9100",
  },
  otherOffers: [
    { vendor: "Precision Shop", price: 612, leadTime: 7, process: "CNC Milling", certs: "ISO 9001" },
    { vendor: "CNC Masters", price: 531, leadTime: 10, process: "CNC Machining", certs: "AS9100" },
  ],
};

export const navItems = [
  { id: "home", label: "Home", icon: "H" },
  { id: "projects", label: "Projects", icon: "P" },
  { id: "parts", label: "All Parts", icon: "A" },
  { id: "requests", label: "Quote Requests", icon: "Q" },
];

export const quickActions = [
  { id: "upload", label: "Upload files", icon: "↑", shortcut: "U" },
  { id: "search", label: "Search parts", icon: "⌘K", shortcut: "⌘K" },
  { id: "new-project", label: "New project", icon: "+", shortcut: "N" },
  { id: "request-quote", label: "Request quotes", icon: "R", shortcut: "R" },
];

export function statusLabel(s) {
  return { received: "Quote ready", requesting: "Awaiting quotes", not_requested: "Not requested", failed: "Failed" }[s] ?? s;
}

export function StatusBadge({ status }) {
  const map = {
    received: ["badge-success", "Received"],
    requesting: ["badge-warning", "Requesting"],
    not_requested: ["badge-neutral", "Not requested"],
    failed: ["badge-danger", "Failed"],
  };
  const [cls, label] = map[status] ?? ["badge-neutral", status];
  return <span className={`badge ${cls}`}>{label}</span>;
}
