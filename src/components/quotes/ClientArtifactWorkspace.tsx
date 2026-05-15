import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Box, FileText, LayoutPanelTop } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

export type ArtifactWorkspaceView = "cad" | "drawing" | "split";

type ClientArtifactWorkspaceProps = {
  itemKey: string;
  hasCad: boolean;
  hasDrawing: boolean;
  cadPanel: ReactNode;
  drawingPanel: ReactNode;
  title?: string;
  description?: string;
  className?: string;
};

function getDefaultArtifactView(hasCad: boolean, hasDrawing: boolean): ArtifactWorkspaceView {
  if (hasCad && hasDrawing) {
    return "split";
  }

  if (hasDrawing) {
    return "drawing";
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
  hasDrawing,
  cadPanel,
  drawingPanel,
  title = "Artifact workspace",
  description = "Use the engineering package as the primary surface. Conversation stays contextual.",
  className,
}: ClientArtifactWorkspaceProps) {
  const availableStateKey = `${itemKey}:${hasCad ? "cad" : "no-cad"}:${hasDrawing ? "drawing" : "no-drawing"}`;
  const [activeView, setActiveView] = useState<ArtifactWorkspaceView>(
    getDefaultArtifactView(hasCad, hasDrawing),
  );

  useEffect(() => {
    setActiveView(getDefaultArtifactView(hasCad, hasDrawing));
  }, [availableStateKey, hasCad, hasDrawing]);

  const splitDisabled = !hasCad || !hasDrawing;
  const activeLabel = useMemo(() => {
    switch (activeView) {
      case "cad":
        return "CAD focus";
      case "drawing":
        return "Drawing focus";
      case "split":
        return "Split view";
      default:
        return "Artifact workspace";
    }
  }, [activeView]);

  return (
    <section className={cn("rounded-[30px] border border-ws-border-strong bg-ws-raised p-5 shadow-[0_2px_24px_rgba(0,0,0,0.35)]", className)}>
      <div className="flex flex-col gap-4 border-b border-border pb-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">{title}</p>
            <p className="mt-2 text-sm text-muted-foreground">{description}</p>
          </div>
          <div className="inline-flex w-fit items-center rounded-full border border-border bg-muted px-3 py-1 text-xs text-muted-foreground">
            {activeLabel}
          </div>
        </div>
        <Tabs value={activeView} onValueChange={(value) => setActiveView(value as ArtifactWorkspaceView)}>
          <TabsList className="h-auto flex-wrap justify-start gap-2 rounded-[16px] bg-muted p-1.5">
            <TabsTrigger
              value="cad"
              disabled={!hasCad}
              className="rounded-[12px] px-3 py-2 text-foreground/80 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"
            >
              <Box className="mr-2 h-4 w-4" />
              CAD
            </TabsTrigger>
            <TabsTrigger
              value="drawing"
              disabled={!hasDrawing}
              className="rounded-[12px] px-3 py-2 text-foreground/80 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"
            >
              <FileText className="mr-2 h-4 w-4" />
              Drawing
            </TabsTrigger>
            <TabsTrigger
              value="split"
              disabled={splitDisabled}
              className="rounded-[12px] px-3 py-2 text-foreground/80 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground"
            >
              <LayoutPanelTop className="mr-2 h-4 w-4" />
              Split
            </TabsTrigger>
          </TabsList>

          <TabsContent value="cad" className="mt-4">
            {hasCad ? (
              cadPanel
            ) : (
              <WorkspaceEmptyState
                title="CAD model not available"
                body="Upload or attach a CAD file to make the 3D package the primary workspace surface."
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

          <TabsContent value="split" className="mt-4">
            {!hasCad && !hasDrawing ? (
              <WorkspaceEmptyState
                title="Artifacts will appear here"
                body="Parts stay visible immediately after upload, even before extraction finishes. CAD and drawing previews will populate as files become available."
              />
            ) : (
              <div className="grid gap-5 xl:grid-cols-2">
                {hasDrawing ? (
                  drawingPanel
                ) : (
                  <WorkspaceEmptyState
                    title="Drawing missing"
                    body="Attach a drawing to compare the source document alongside the CAD package."
                  />
                )}
                {hasCad ? (
                  cadPanel
                ) : (
                  <WorkspaceEmptyState
                    title="CAD missing"
                    body="Attach a CAD file to complete the engineering package and compare artifacts side by side."
                  />
                )}
              </div>
            )}
          </TabsContent>
        </Tabs>
      </div>
    </section>
  );
}
