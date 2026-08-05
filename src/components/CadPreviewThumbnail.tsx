import { useEffect, useState } from "react";
import { Box } from "lucide-react";
import { CadIsoThumbnail } from "@/components/CadIsoThumbnail";
import type { CadPreviewAssetRecord } from "@/features/quotes/types";
import type { CadPreviewSource } from "@/lib/cad-preview";
import { downloadStoredFileBlob } from "@/lib/stored-file";
import { cn } from "@/lib/utils";

type CadPreviewThumbnailProps = {
  asset: CadPreviewAssetRecord | null;
  fallbackSource: CadPreviewSource | null;
  className?: string;
};

/** Prefers the persisted worker preview and retains local rendering as fallback. */
export function CadPreviewThumbnail({
  asset,
  fallbackSource,
  className,
}: CadPreviewThumbnailProps) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    let objectUrl: string | null = null;
    setPreviewUrl(null);

    if (!asset) {
      return;
    }

    void downloadStoredFileBlob({
      storage_bucket: asset.storage_bucket,
      storage_path: asset.storage_path,
      original_name: "CAD preview",
      mime_type: asset.mime_type,
    })
      .then((blob) => {
        if (disposed) {
          return;
        }

        objectUrl = URL.createObjectURL(blob);
        setPreviewUrl(objectUrl);
      })
      .catch(() => {
        if (!disposed) {
          setPreviewUrl(null);
        }
      });

    return () => {
      disposed = true;
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [asset]);

  if (previewUrl) {
    return (
      <span
        role="img"
        aria-label="Isometric CAD sketch preview"
        className={cn("flex h-full w-full items-center justify-center overflow-hidden", className)}
      >
        <img
          src={previewUrl}
          alt=""
          aria-hidden="true"
          className="h-full w-full object-contain"
          onError={() => setPreviewUrl(null)}
        />
      </span>
    );
  }

  if (fallbackSource) {
    return <CadIsoThumbnail source={fallbackSource} className={className} />;
  }

  return (
    <span
      role="img"
      aria-label="Part preview unavailable"
      className={cn("flex h-full w-full items-center justify-center text-paper-muted", className)}
    >
      <Box className="h-7 w-7" aria-hidden="true" />
    </span>
  );
}
