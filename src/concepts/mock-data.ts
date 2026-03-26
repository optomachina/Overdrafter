export type ProjectStatus = "active" | "review" | "archived";
export type PartStatus = "quoted" | "requesting" | "needs_attention" | "selected";
export type QuoteTier = "Standard" | "Expedited" | "Economy";
export type ActivityType = "quote_received" | "spec_updated" | "file_uploaded" | "selection_made";

export type MockProject = {
  id: string;
  name: string;
  partCount: number;
  status: ProjectStatus;
  updatedAt: string;
  quotedCount: number;
  totalValue: number;
};

export type MockPart = {
  id: string;
  partNumber: string;
  name: string;
  material: string;
  finish: string;
  tolerance: string;
  quantity: number;
  status: PartStatus;
  bestPrice: number | null;
  leadTimeDays: number | null;
  revision: string;
  projectId: string;
};

export type MockVendorQuote = {
  vendor: string;
  process: string;
  price: number;
  leadTimeDays: number;
  tier: QuoteTier;
  cert: string | null;
  selected: boolean;
};

export type MockActivityEvent = {
  id: string;
  type: ActivityType;
  actor: string;
  message: string;
  timestamp: string;
};

export const MOCK_PROJECTS: MockProject[] = [
  { id: "proj-1", name: "Actuator Housing Assembly", partCount: 7, status: "active", updatedAt: "2026-03-24", quotedCount: 5, totalValue: 4820 },
  { id: "proj-2", name: "Gearbox Bracket Set", partCount: 3, status: "active", updatedAt: "2026-03-22", quotedCount: 3, totalValue: 1290 },
  { id: "proj-3", name: "Sensor Mount Rev D", partCount: 2, status: "review", updatedAt: "2026-03-20", quotedCount: 2, totalValue: 640 },
  { id: "proj-4", name: "Coolant Manifold Prototype", partCount: 4, status: "archived", updatedAt: "2026-03-15", quotedCount: 2, totalValue: 0 },
];

export const MOCK_PARTS: MockPart[] = [
  { id: "part-1", partNumber: "AHA-01093-C", name: "Main Housing Body", material: "6061-T6 Aluminum", finish: "Clear Anodize Type II", tolerance: "±0.003 in", quantity: 10, status: "quoted", bestPrice: 487, leadTimeDays: 12, revision: "Rev C", projectId: "proj-1" },
  { id: "part-2", partNumber: "AHA-01094-A", name: "End Cap Flange", material: "303 Stainless Steel", finish: "Passivate per ASTM A967", tolerance: "±0.005 in", quantity: 10, status: "requesting", bestPrice: null, leadTimeDays: null, revision: "Rev A", projectId: "proj-1" },
  { id: "part-3", partNumber: "GBK-00221-B", name: "Lower Bracket", material: "7075-T73 Aluminum", finish: "Hard Anodize Type III", tolerance: "±0.002 in", quantity: 25, status: "quoted", bestPrice: 312, leadTimeDays: 8, revision: "Rev B", projectId: "proj-2" },
  { id: "part-4", partNumber: "GBK-00222-A", name: "Upper Bracket Weld", material: "4140 Steel", finish: "Black Oxide", tolerance: "±0.010 in", quantity: 25, status: "needs_attention", bestPrice: null, leadTimeDays: null, revision: "Rev A", projectId: "proj-2" },
  { id: "part-5", partNumber: "SMD-00445-D", name: "Sensor Bracket Ring", material: "6061-T6 Aluminum", finish: "Bead Blast + Clear Anodize", tolerance: "±0.001 in", quantity: 50, status: "selected", bestPrice: 192, leadTimeDays: 5, revision: "Rev D", projectId: "proj-3" },
];

export const MOCK_VENDOR_QUOTES: MockVendorQuote[] = [
  { vendor: "Xometry", process: "CNC Machining", price: 487, leadTimeDays: 12, tier: "Standard", cert: "AS9100", selected: false },
  { vendor: "Protolabs", process: "CNC Machining", price: 612, leadTimeDays: 7, tier: "Expedited", cert: "ISO 9001", selected: false },
  { vendor: "eMachineShop", process: "CNC Machining", price: 431, leadTimeDays: 18, tier: "Economy", cert: null, selected: true },
  { vendor: "Xometry", process: "CNC Machining", price: 552, leadTimeDays: 10, tier: "Expedited", cert: "AS9100", selected: false },
  { vendor: "Fictiv", process: "CNC Machining", price: 498, leadTimeDays: 14, tier: "Standard", cert: "ISO 9001", selected: false },
];

export const MOCK_ACTIVITY: MockActivityEvent[] = [
  { id: "e1", type: "quote_received", actor: "System", message: "Quote received from Xometry — $487 for 10 pcs", timestamp: "2026-03-24T14:32:00Z" },
  { id: "e2", type: "spec_updated", actor: "Jordan M.", message: "Updated material spec: 6061-T6 → confirmed per drawing rev C", timestamp: "2026-03-24T11:10:00Z" },
  { id: "e3", type: "quote_received", actor: "System", message: "Quote received from eMachineShop — $431 for 10 pcs", timestamp: "2026-03-23T16:55:00Z" },
  { id: "e4", type: "file_uploaded", actor: "Alex R.", message: "Drawing updated: AHA-01093-C_RevC.pdf", timestamp: "2026-03-22T09:20:00Z" },
  { id: "e5", type: "selection_made", actor: "Jordan M.", message: "Selected eMachineShop Economy — $431", timestamp: "2026-03-21T15:00:00Z" },
];

export function formatRelativeTime(isoTimestamp: string): string {
  const diff = Date.now() - new Date(isoTimestamp).getTime();
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(new Date(isoTimestamp));
}

export function getStatusLabel(status: PartStatus | ProjectStatus): string {
  const labels: Record<string, string> = {
    quoted: "Quoted",
    requesting: "Requesting",
    needs_attention: "Needs Attention",
    selected: "Selected",
    active: "Active",
    review: "In Review",
    archived: "Archived",
  };
  return labels[status] ?? status;
}
