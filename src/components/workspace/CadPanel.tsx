import { ClientCadPreviewPanel } from "@/components/quotes/ClientQuoteAssetPanels";
import type { JobFileRecord } from "@/features/quotes/types";

type CadPanelProps = {
  cadFile: JobFileRecord | null | undefined;
};

export function CadPanel({ cadFile }: CadPanelProps) {
  return (
    <div>
      <p className="mb-[6px] text-[9px] font-bold uppercase tracking-[0.14em] text-white/20">CAD model</p>
      <ClientCadPreviewPanel cadFile={cadFile ?? null} />
    </div>
  );
}

export type { CadPanelProps };
