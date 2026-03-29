import { useMemo, useState } from "react";
import { FileText, FolderOpen, CheckCircle2 } from "lucide-react";
import { ConceptShell } from "@/concepts/ConceptShell";
import { MOCK_PROJECTS, MOCK_PARTS, MOCK_VENDOR_QUOTES } from "@/concepts/mock-data";
import { GeometryProjectionView } from "@/components/workspace/GeometryProjectionView";

function Sidebar() {
  return (
    <div className="flex flex-col gap-1 p-2 pt-3">
      <p className="px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.2em] text-white/35">Projects</p>
      {MOCK_PROJECTS.slice(0, 3).map((p) => (
        <button key={p.id} type="button" className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-white/[0.06] text-white/60">
          <FolderOpen className="h-3.5 w-3.5 shrink-0 text-white/40" />
          <span className="truncate">{p.name}</span>
        </button>
      ))}
    </div>
  );
}

const part = MOCK_PARTS[0];

function DrawingArea() {
  return (
    <div className="relative flex h-full items-center justify-center overflow-hidden border-b border-white/[0.08] bg-[#050810]">
      <div className="absolute inset-0 opacity-[0.035]"
        style={{ backgroundImage: "repeating-linear-gradient(0deg, transparent, transparent 23px, rgba(0,200,255,0.5) 23px, rgba(0,200,255,0.5) 24px), repeating-linear-gradient(90deg, transparent, transparent 23px, rgba(0,200,255,0.5) 23px, rgba(0,200,255,0.5) 24px)" }} />
      <div className="z-10 flex flex-col items-center gap-3">
        <FileText className="h-14 w-14 text-sky-400/20" />
        <div className="text-center">
          <p className="font-mono text-base font-semibold text-sky-400/40">{part.partNumber}</p>
          <p className="mt-1 text-[11px] text-white/25">AHA-01093-C_RevC.pdf · 3 pages</p>
        </div>
        <button type="button" className="rounded-lg border border-sky-400/20 bg-sky-400/10 px-3 py-1.5 text-[11px] font-medium text-sky-400 hover:bg-sky-400/15 transition">
          Open Drawing
        </button>
      </div>
    </div>
  );
}

function SpecCard() {
  const fields = [
    ["Part Number", part.partNumber, true],
    ["Revision", part.revision, false],
    ["Material", part.material, false],
    ["Finish", part.finish, false],
    ["Tolerance", part.tolerance, true],
    ["Quantity", String(part.quantity), false],
  ] as const;

  return (
    <div className="rounded-2xl border border-white/[0.08] bg-ws-card p-4">
      <p className="mb-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-white/40">Specifications</p>
      <div className="grid grid-cols-2 gap-x-4 gap-y-2.5">
        {fields.map(([label, value, mono]) => (
          <div key={label} className="flex flex-col gap-0.5">
            <span className="text-[10px] text-white/35">{label}</span>
            <span className={`text-[13px] text-white/85 ${mono ? "font-mono" : ""}`}>{value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function VendorCards({
  selectedCostDriver,
  onHoverCostDriver,
}: {
  selectedCostDriver: string | null;
  onHoverCostDriver: (featureId: string | null) => void;
}) {
  return (
    <div className="rounded-2xl border border-white/[0.08] bg-ws-card p-4">
      <p className="mb-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-white/40">Quotes — {MOCK_VENDOR_QUOTES.length} received</p>
      <div className="space-y-2">
        {MOCK_VENDOR_QUOTES.map((q, i) => (
          <div key={i} className={`flex items-center justify-between rounded-xl border p-3 ${q.selected ? "border-sky-400/25 bg-sky-500/[0.07] ring-1 ring-sky-400/15" : "border-white/[0.06] bg-white/[0.02]"}`}>
            <div>
              <div className="flex items-center gap-1.5">
                {q.selected && <CheckCircle2 className="h-3.5 w-3.5 text-sky-400" />}
                <span className="text-sm font-medium text-white/90">{q.vendor}</span>
              </div>
              <p className="mt-0.5 font-mono text-[11px] text-white/40">{q.tier} · {q.leadTimeDays}d</p>
            </div>
            <div className="text-right">
              <p className="font-mono text-lg font-semibold text-white">${q.price}</p>
              {q.cert && <span className="text-[10px] text-sky-400/70">{q.cert}</span>}
            </div>
            <button
              type="button"
              className="ml-3 rounded-md border border-white/10 px-2 py-1 text-[10px] text-white/60 hover:bg-white/[0.06]"
              onMouseEnter={() => onHoverCostDriver(i % 2 === 0 ? "pocket-1" : "hole-1")}
              onMouseLeave={() => onHoverCostDriver(null)}
            >
              {selectedCostDriver ? "Driver linked" : "Show driver"}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

export function Set3PartPage() {
  const [selectedFeatureId, setSelectedFeatureId] = useState<string | null>(null);
  const [overlayEnabled, setOverlayEnabled] = useState(true);
  const conceptProjection = useMemo(
    () => ({
      schemaVersion: "geometry_projection.v1",
      extractorVersion: "concept-mock",
      generatedFrom: { drawingExtraction: true, approvedRequirement: false },
      scene: {
        width: 92,
        height: 28,
        depth: 64,
        primitives: [
          {
            id: "body-main",
            kind: "box" as const,
            position: { x: 0, y: 0, z: 0 },
            size: { x: 92, y: 28, z: 64 },
            metadata: { featureClass: "body" as const, confidence: 0.83 },
          },
          {
            id: "hole-1",
            kind: "hole" as const,
            position: { x: -14, y: 0, z: -10 },
            size: { x: 8, y: 28, z: 8 },
            metadata: { featureClass: "hole" as const, confidence: 0.66 },
          },
          {
            id: "pocket-1",
            kind: "cutout" as const,
            position: { x: 15, y: 5, z: 10 },
            size: { x: 26, y: 14, z: 14 },
            metadata: { featureClass: "pocket" as const, confidence: 0.61 },
          },
        ],
      },
    }),
    [],
  );

  return (
    <ConceptShell sidebarContent={<Sidebar />} headerTitle={part.name} headerBreadcrumb="Actuator Housing Assembly">
      <div className="flex h-full flex-col">
        <div className="h-56 shrink-0">
          <DrawingArea />
        </div>
        <div className="flex-1 overflow-auto">
          <div className="grid grid-cols-2 gap-4 p-4">
            <SpecCard />
            <div className="space-y-2 rounded-2xl border border-white/[0.08] bg-ws-card p-3">
              <div className="flex items-center justify-between px-1 pt-1">
                <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-white/40">
                  Geometry-first manufacturing view
                </p>
                <button
                  type="button"
                  className="rounded-full border border-white/10 px-2 py-0.5 text-[10px] text-white/65"
                  onClick={() => setOverlayEnabled((current) => !current)}
                >
                  Overlay {overlayEnabled ? "on" : "off"}
                </button>
              </div>
              <GeometryProjectionView
                projection={conceptProjection}
                overlayEnabled={overlayEnabled}
                highlightedFeatureIds={selectedFeatureId ? [selectedFeatureId] : []}
                onSelectFeature={setSelectedFeatureId}
                className="rounded-lg"
              />
            </div>
            <VendorCards
              selectedCostDriver={selectedFeatureId}
              onHoverCostDriver={setSelectedFeatureId}
            />
          </div>
        </div>
      </div>
    </ConceptShell>
  );
}
