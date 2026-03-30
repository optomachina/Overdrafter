import { cn } from "@/lib/utils";
import type { DrawingExtractionData } from "@/features/quotes/types";

type GeometryProjection = NonNullable<DrawingExtractionData["geometryProjection"]>;

export function GeometryProjectionView({
  projection,
  className,
  highlightedFeatureIds = [],
  onSelectFeature,
  overlayEnabled = false,
}: {
  projection: GeometryProjection;
  className?: string;
  highlightedFeatureIds?: string[];
  onSelectFeature?: (featureId: string) => void;
  overlayEnabled?: boolean;
}) {
  const viewBoxWidth = 320;
  const viewBoxHeight = 220;
  const maxX = Math.max(projection.scene.width, 1);
  const maxZ = Math.max(projection.scene.depth, 1);

  return (
    <div className={cn("h-[320px] w-full bg-[#12161f]", className)}>
      <svg viewBox={`0 0 ${viewBoxWidth} ${viewBoxHeight}`} className="h-full w-full">
        <rect x={0} y={0} width={viewBoxWidth} height={viewBoxHeight} fill="#0e1219" />
        {projection.scene.primitives.map((primitive) => {
          const projectedWidth = Math.max(8, (primitive.size.x / maxX) * 210);
          const projectedHeight = Math.max(8, (primitive.size.z / maxZ) * 140);
          const x = 35 + ((primitive.position.x + maxX / 2) / maxX) * 210;
          const y = 36 + ((primitive.position.z + maxZ / 2) / maxZ) * 140;
          const highlighted = highlightedFeatureIds.includes(primitive.id);
          const riskTint = overlayEnabled
            ? primitive.metadata.featureClass === "wall"
              ? "#fb923c"
              : primitive.metadata.featureClass === "pocket"
                ? "#facc15"
                : primitive.metadata.featureClass === "hole"
                  ? "#38bdf8"
                  : "#67e8f9"
            : "#67e8f9";

          return (
            <g key={primitive.id}>
              <rect
                x={x}
                y={y}
                width={projectedWidth}
                height={projectedHeight}
                fill={riskTint}
                opacity={highlighted ? 0.96 : 0.5}
                stroke={highlighted ? "#f8fafc" : "rgba(248,250,252,0.2)"}
                strokeWidth={highlighted ? 2 : 1}
                rx={primitive.kind === "cylinder" || primitive.kind === "hole" ? 999 : 3}
                className="cursor-pointer transition-all"
                onClick={() => onSelectFeature?.(primitive.id)}
              />
              {overlayEnabled && primitive.metadata.featureClass !== "body" ? (
                <text x={x + 3} y={y + 10} fontSize={9} fill="rgba(248,250,252,0.95)">
                  {primitive.metadata.featureClass}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
