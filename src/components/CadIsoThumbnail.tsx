import { useEffect, useMemo, useRef, useState } from "react";
import { Box, Loader2 } from "lucide-react";
import {
  projectCadMeshesForThumbnail,
  type ProjectedCadGeometry,
} from "@/lib/cad-iso-thumbnail";
import { isStepPreviewableFile, loadCadPreview, type CadPreviewSource } from "@/lib/cad-preview";
import { cn } from "@/lib/utils";

const PREVIEW_SIZE = 192;
const projectionCache = new Map<string, Promise<ProjectedCadGeometry>>();
let projectionQueue: Promise<void> = Promise.resolve();

type CadIsoThumbnailProps = {
  readonly source: CadPreviewSource;
  readonly className?: string;
};

export function CadIsoThumbnail({ source, className }: CadIsoThumbnailProps) {
  const hostRef = useRef<HTMLSpanElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const previewable = useMemo(() => isStepPreviewableFile(source.fileName), [source.fileName]);
  const [shouldRender, setShouldRender] = useState(false);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");

  useEffect(() => {
    const host = hostRef.current;

    if (!host || !previewable) {
      setStatus("error");
      return;
    }

    if (typeof IntersectionObserver === "undefined") {
      setShouldRender(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setShouldRender(true);
          observer.disconnect();
        }
      },
      { rootMargin: "160px" },
    );
    observer.observe(host);

    return () => observer.disconnect();
  }, [previewable]);

  useEffect(() => {
    const canvas = canvasRef.current;

    if (!canvas || !shouldRender || !previewable) {
      return;
    }

    let disposed = false;
    setStatus("loading");

    void loadProjectedCadGeometry(source)
      .then((projection) => {
        if (disposed) {
          return;
        }

        drawProjectedCadThumbnail(canvas, projection);
        setStatus("ready");
      })
      .catch(() => {
        if (!disposed) {
          setStatus("error");
        }
      });

    return () => {
      disposed = true;
    };
  }, [previewable, shouldRender, source, source.cacheKey]);

  let statusLabel = "Generating isometric preview";
  if (status === "error") {
    statusLabel = "Part preview unavailable";
  }

  return (
    <span
      ref={hostRef}
      role="img"
      aria-label={`Isometric CAD sketch preview for ${source.fileName}`}
      data-state={status}
      className={cn("relative flex h-full w-full items-center justify-center overflow-hidden", className)}
    >
      <canvas
        ref={canvasRef}
        width={PREVIEW_SIZE}
        height={PREVIEW_SIZE}
        className={cn("h-full w-full transition-opacity duration-200", status === "ready" ? "opacity-100" : "opacity-0")}
      />
      {status !== "ready" ? (
        <span className="absolute inset-0 flex items-center justify-center text-paper-muted" aria-hidden="true">
          {status === "loading" ? <Loader2 className="h-5 w-5 animate-spin" /> : <Box className="h-6 w-6" />}
        </span>
      ) : null}
      <span className="sr-only">{statusLabel}</span>
    </span>
  );
}

function loadProjectedCadGeometry(source: CadPreviewSource): Promise<ProjectedCadGeometry> {
  const existing = projectionCache.get(source.cacheKey);
  if (existing !== undefined) {
    return existing;
  }

  const pending = projectionQueue.then(async () => projectCadMeshesForThumbnail((await loadCadPreview(source)).meshes));
  projectionQueue = pending.then(
    () => undefined,
    () => undefined,
  );
  const cached = pending.catch((error) => {
    projectionCache.delete(source.cacheKey);
    throw error;
  });
  projectionCache.set(source.cacheKey, cached);

  return cached;
}

function drawProjectedCadThumbnail(canvas: HTMLCanvasElement, projection: ProjectedCadGeometry) {
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Canvas rendering is unavailable.");
  }

  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = PREVIEW_SIZE * pixelRatio;
  canvas.height = PREVIEW_SIZE * pixelRatio;
  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  context.clearRect(0, 0, PREVIEW_SIZE, PREVIEW_SIZE);

  const padding = 14;
  const width = Math.max(projection.bounds.maxX - projection.bounds.minX, 1);
  const height = Math.max(projection.bounds.maxY - projection.bounds.minY, 1);
  const scale = Math.min((PREVIEW_SIZE - padding * 2) / width, (PREVIEW_SIZE - padding * 2) / height);
  const offsetX = (PREVIEW_SIZE - width * scale) / 2 - projection.bounds.minX * scale;
  const offsetY = (PREVIEW_SIZE - height * scale) / 2 - projection.bounds.minY * scale;
  const dark = document.documentElement.classList.contains("dark");

  projection.triangles.forEach((triangle) => {
    const [first, second, third] = triangle.points;
    const lightness = dark ? 20 + triangle.shade * 12 : 84 + triangle.shade * 11;

    context.beginPath();
    context.moveTo(first.x * scale + offsetX, first.y * scale + offsetY);
    context.lineTo(second.x * scale + offsetX, second.y * scale + offsetY);
    context.lineTo(third.x * scale + offsetX, third.y * scale + offsetY);
    context.closePath();
    context.fillStyle = `hsl(38, ${dark ? 8 : 20}%, ${lightness}%)`;
    context.fill();

    triangle.edges.forEach(([start, end]) => {
      const startX = start.x * scale + offsetX;
      const startY = start.y * scale + offsetY;
      const endX = end.x * scale + offsetX;
      const endY = end.y * scale + offsetY;

      context.beginPath();
      context.moveTo(startX, startY);
      context.lineTo(endX, endY);
      context.strokeStyle = dark ? "rgba(231, 224, 212, 0.88)" : "#49453e";
      context.lineWidth = 1.05;
      context.lineCap = "round";
      context.setLineDash([]);
      context.stroke();

      context.save();
      context.translate(0.42, -0.28);
      context.beginPath();
      context.moveTo(startX, startY);
      context.lineTo(endX, endY);
      context.strokeStyle = dark ? "rgba(190, 180, 163, 0.42)" : "rgba(117, 111, 100, 0.5)";
      context.lineWidth = 0.52;
      context.setLineDash([1.15, 0.72]);
      context.stroke();
      context.restore();
    });
  });
}
