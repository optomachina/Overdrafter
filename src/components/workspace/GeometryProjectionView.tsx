import { cn } from "@/lib/utils";
import type { GeometryProjection } from "@/features/quotes/geometry-projection";

const STYLES: Record<string, string> = {
  box: "fill-sky-500/35 stroke-sky-300",
  cylinder: "fill-emerald-500/35 stroke-emerald-300",
  hole: "fill-amber-500/35 stroke-amber-300",
  cutout: "fill-rose-500/35 stroke-rose-300",
};

type Props = {
  projection: GeometryProjection;
  highlightedFeatureIds?: string[];
  selectedFeatureId?: string | null;
  onFeatureSelect?: (featureId: string) => void;
  className?: string;
};

export function GeometryProjectionView({
  projection,
  highlightedFeatureIds = [],
  selectedFeatureId = null,
  onFeatureSelect,
  className,
}: Props) {
  const highlighted = new Set(highlightedFeatureIds);

  return (
    <div className={cn("relative h-[320px] w-full overflow-hidden rounded-2xl border border-white/10 bg-[#0f1012]", className)}>
      <svg viewBox="0 0 100 100" role="img" aria-label="Manufacturing geometry projection" className="h-full w-full">
        {projection.primitives.map((primitive) => {
          const active = selectedFeatureId === primitive.featureId || highlighted.has(primitive.featureId);
          const style = STYLES[primitive.type] ?? "fill-white/25 stroke-white/60";

          return (
            <rect
              key={primitive.id}
              x={primitive.x}
              y={primitive.y}
              width={primitive.width}
              height={primitive.height}
              rx={primitive.type === "cylinder" ? Math.min(primitive.width, primitive.height) / 2 : 3}
              className={cn(style, "cursor-pointer stroke-[0.8] transition-opacity", active ? "opacity-100" : "opacity-70 hover:opacity-90")}
              onClick={() => onFeatureSelect?.(primitive.featureId)}
            />
          );
        })}
      </svg>
      <p className="absolute bottom-2 right-2 rounded-full border border-white/15 bg-black/40 px-2 py-1 text-[10px] uppercase tracking-[0.16em] text-white/60">
        Heerich-derived view
      </p>
    </div>
  );
}

