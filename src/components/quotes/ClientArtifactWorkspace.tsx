import { useEffect, useState, type ReactNode } from "react";
import { Box, FileText } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

export type ArtifactWorkspaceView = "cad" | "drawing";

type ClientArtifactWorkspaceProps = {
  itemKey: string;
  hasCad: boolean;
  hasCadPreview?: boolean;
  hasDrawing: boolean;
  cadPanel: ReactNode;
  drawingPanel: ReactNode;
  title?: string;
  description?: string;
  className?: string;
};

function getDefaultArtifactView(
  hasCad: boolean,
  hasCadPreview: boolean,
  hasDrawing: boolean,
): ArtifactWorkspaceView {
  if (hasCad && hasCadPreview) {
    return "cad";
  }

  if (hasDrawing) {
    return "drawing";
  }

  if (hasCad) {
    return "cad";
  }

  return "cad";
}

function WorkspaceEmptyState({
  title,
  body,
}: {
  title: string;
  body: string;
}) {
  return (
    <div className="flex min-h-[460px] items-center justify-center rounded-surface-lg border border-dashed border-ws-border bg-ws-inset p-8">
      <div className="max-w-md text-center">
        <p className="text-lg font-medium text-foreground">{title}</p>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">{body}</p>
      </div>
    </div>
  );
}

export function ClientArtifactWorkspace({
  itemKey,
  hasCad,
  hasCadPreview = hasCad,
  hasDrawing,
  cadPanel,
  drawingPanel,
  title = "Part preview",
  description,
  className,
}: ClientArtifactWorkspaceProps) {
  const availableStateKey = `${itemKey}:${hasCad ? "cad" : "no-cad"}:${hasCadPreview ? "preview" : "no-preview"}:${hasDrawing ? "drawing" : "no-drawing"}`;
  const [activeView, setActiveView] = useState<ArtifactWorkspaceView>(
    getDefaultArtifactView(hasCad, hasCadPreview, hasDrawing),
  );

  useEffect(() => {
    setActiveView(getDefaultArtifactView(hasCad, hasCadPreview, hasDrawing));
  }, [availableStateKey, hasCad, hasCadPreview, hasDrawing]);

  return (
    <section className={cn("border-t border-border pt-4", className)} aria-label={title}>
      <Tabs value={activeView} onValueChange={(value) => setActiveView(value as ArtifactWorkspaceView)}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-medium text-foreground">{title}</h2>
            {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
          </div>
          <TabsList className="h-12 rounded-[4px] border border-border bg-muted p-0.5 sm:h-9">
            <TabsTrigger
              value="cad"
              disabled={!hasCad}
              className="h-11 rounded-[3px] px-3 text-foreground/80 data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-none sm:h-8"
            >
              <Box className="mr-2 h-4 w-4" />
              CAD
            </TabsTrigger>
            <TabsTrigger
              value="drawing"
              disabled={!hasDrawing}
              className="h-11 rounded-[3px] px-3 text-foreground/80 data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-none sm:h-8"
            >
              <FileText className="mr-2 h-4 w-4" />
              Drawing
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="cad" className="mt-4">
          {hasCad ? (
            cadPanel
          ) : (
            <WorkspaceEmptyState
              title={hasDrawing ? "CAD model not available" : "Artifacts will appear here"}
              body={hasDrawing
                ? "Attach a CAD file to add the 3D model to this part."
                : "CAD and drawing previews will populate as files become available."}
            />
          )}
        </TabsContent>

        <TabsContent value="drawing" className="mt-4">
          {hasDrawing ? (
            drawingPanel
          ) : (
            <WorkspaceEmptyState
              title="Drawing not available"
              body="A PDF drawing will appear here once the part package includes one."
            />
          )}
        </TabsContent>
      </Tabs>
    </section>
  );
}
