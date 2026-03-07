import { useEffect } from "react";
import { Bug, ClipboardCopy, Copy, Eraser, LifeBuoy, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  clearDiagnosticsEvents,
  copyTextToClipboard,
  createDiagnosticClipboardText,
  createDiagnosticsReport,
  setDiagnosticsEnabled,
  setDiagnosticsPanelOpen,
  toggleDiagnosticsPanel,
  useDiagnosticsSnapshot,
  type DiagnosticEvent,
} from "@/lib/diagnostics";
import { toast } from "sonner";

function formatTimestamp(value: string) {
  return new Date(value).toLocaleString();
}

function formatJson(value: unknown) {
  return JSON.stringify(value, null, 2);
}

function eventBadgeVariant(level: DiagnosticEvent["level"]) {
  switch (level) {
    case "error":
      return "destructive";
    case "warn":
      return "secondary";
    default:
      return "outline";
  }
}

function EventRow({ event }: { event: DiagnosticEvent }) {
  const handleCopyEvent = async () => {
    try {
      await copyTextToClipboard(
        createDiagnosticClipboardText({
          title: "Overdrafter diagnostics event",
          event,
        }),
      );
      toast.success("Diagnostic event copied.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to copy diagnostic event.");
    }
  };

  return (
    <div className="rounded-2xl border border-border/70 bg-muted/20 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={eventBadgeVariant(event.level)}>{event.level}</Badge>
          <Badge variant="outline">{event.category}</Badge>
          <span className="text-xs text-muted-foreground">{formatTimestamp(event.timestamp)}</span>
        </div>
        <Button
          variant="outline"
          size="icon"
          onClick={handleCopyEvent}
          aria-label="Copy diagnostic event"
          title="Copy diagnostic event"
        >
          <Copy className="h-4 w-4" />
        </Button>
      </div>
      <div className="mt-3 space-y-2">
        <p className="text-sm font-medium">{event.message}</p>
        <p className="text-xs text-muted-foreground">{event.source}</p>
        {event.error ? (
          <div className="rounded-xl bg-background/80 p-3">
            <p className="text-xs font-medium">{event.error.name}</p>
            {event.error.code ? <p className="mt-1 text-xs text-muted-foreground">Code: {event.error.code}</p> : null}
            {event.error.hint ? <p className="mt-1 text-xs text-muted-foreground">Hint: {event.error.hint}</p> : null}
            {event.error.details ? (
              <pre className="mt-2 whitespace-pre-wrap break-words text-[11px] text-muted-foreground">
                {event.error.details}
              </pre>
            ) : null}
            {event.error.stack ? (
              <details className="mt-2 text-xs text-muted-foreground">
                <summary className="cursor-pointer select-none">Stack trace</summary>
                <pre className="mt-2 whitespace-pre-wrap break-words text-[11px]">{event.error.stack}</pre>
              </details>
            ) : null}
          </div>
        ) : null}
        {event.details ? (
          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer select-none">Event details</summary>
            <pre className="mt-2 whitespace-pre-wrap break-words text-[11px]">{formatJson(event.details)}</pre>
          </details>
        ) : null}
        <p className="text-[11px] text-muted-foreground">Reference: {event.id}</p>
      </div>
    </div>
  );
}

export function DiagnosticsPanel() {
  const diagnostics = useDiagnosticsSnapshot();
  const reportText = formatJson(createDiagnosticsReport());
  const latestError = diagnostics.events.find((event) => event.level === "error") ?? null;
  const launcherVisible = diagnostics.enabled || import.meta.env.DEV;

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "d") {
        event.preventDefault();
        toggleDiagnosticsPanel();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const handleCopyReport = async () => {
    try {
      await copyTextToClipboard(reportText);
      toast.success("Diagnostics copied to clipboard.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to copy diagnostics.");
    }
  };

  const handleCopyLatestError = async () => {
    if (!latestError) {
      return;
    }

    try {
      await copyTextToClipboard(
        createDiagnosticClipboardText({
          title: "Overdrafter latest error",
          event: latestError,
        }),
      );
      toast.success("Latest error copied.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to copy latest error.");
    }
  };

  return (
    <>
      {launcherVisible ? (
        <Button
          type="button"
          size="sm"
          className="fixed bottom-4 right-4 z-40 gap-2 rounded-full px-4 shadow-2xl"
          variant={latestError ? "destructive" : "default"}
          onClick={() => setDiagnosticsPanelOpen(true)}
        >
          {latestError ? <TriangleAlert className="h-4 w-4" /> : <Bug className="h-4 w-4" />}
          Diagnostics
        </Button>
      ) : null}

      <Sheet open={diagnostics.panelOpen} onOpenChange={setDiagnosticsPanelOpen}>
        <SheetContent side="right" className="w-[min(96vw,56rem)] overflow-hidden p-0 sm:max-w-[56rem]">
          <div className="flex h-full flex-col">
            <SheetHeader className="border-b border-border/70 px-6 py-5">
              <SheetTitle className="flex items-center gap-2">
                <LifeBuoy className="h-5 w-5" />
                Troubleshooting console
              </SheetTitle>
              <SheetDescription>
                Recent app errors, warnings, route context, and an exportable diagnostics bundle. Shortcut:
                {" "}
                <span className="font-medium">Ctrl/Cmd + Shift + D</span>
              </SheetDescription>
            </SheetHeader>

            <div className="flex items-center justify-between gap-3 border-b border-border/70 px-6 py-4">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline">session {diagnostics.sessionId.slice(0, 8)}</Badge>
                <Badge variant={latestError ? "destructive" : "outline"}>
                  {diagnostics.counts.error} errors
                </Badge>
                <Badge variant="outline">{diagnostics.counts.warn} warnings</Badge>
                <Badge variant="outline">{diagnostics.events.length} events</Badge>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" onClick={() => setDiagnosticsEnabled(!diagnostics.enabled)}>
                  {diagnostics.enabled ? "Hide launcher" : "Show launcher"}
                </Button>
                <Button variant="outline" size="sm" onClick={clearDiagnosticsEvents}>
                  <Eraser className="mr-2 h-4 w-4" />
                  Clear
                </Button>
                <Button size="sm" onClick={handleCopyReport}>
                  <ClipboardCopy className="mr-2 h-4 w-4" />
                  Copy report
                </Button>
              </div>
            </div>

            <Tabs defaultValue="overview" className="flex min-h-0 flex-1 flex-col px-6 py-4">
              <TabsList className="w-fit">
                <TabsTrigger value="overview">Overview</TabsTrigger>
                <TabsTrigger value="events">Events</TabsTrigger>
                <TabsTrigger value="report">Report</TabsTrigger>
              </TabsList>

              <TabsContent value="overview" className="min-h-0 flex-1">
                <ScrollArea className="h-[calc(100vh-18rem)] pr-4">
                  <div className="space-y-4 pb-6">
                    <div className="grid gap-3 md:grid-cols-3">
                      <div className="rounded-2xl border border-border/70 bg-muted/20 p-4">
                        <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Route</p>
                        <p className="mt-2 break-words text-sm font-medium">
                          {diagnostics.context.route ?? "Unknown"}
                        </p>
                      </div>
                      <div className="rounded-2xl border border-border/70 bg-muted/20 p-4">
                        <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">User</p>
                        <p className="mt-2 break-words text-sm font-medium">
                          {diagnostics.context.userEmail ?? "Anonymous"}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {diagnostics.context.membershipRole ?? "No active membership"}
                        </p>
                      </div>
                      <div className="rounded-2xl border border-border/70 bg-muted/20 p-4">
                        <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Client state</p>
                        <p className="mt-2 text-sm font-medium">
                          {diagnostics.context.online === false ? "Offline" : "Online"}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {diagnostics.context.viewport ?? "Unknown viewport"}
                        </p>
                      </div>
                    </div>

                    {latestError ? (
                      <div className="rounded-3xl border border-destructive/30 bg-destructive/5 p-5">
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex items-start gap-3">
                            <TriangleAlert className="mt-0.5 h-5 w-5 text-destructive" />
                            <div>
                              <p className="text-sm font-semibold">Latest error</p>
                              <p className="mt-2 text-sm">{latestError.message}</p>
                              <p className="mt-2 text-xs text-muted-foreground">
                                {latestError.source} at {formatTimestamp(latestError.timestamp)}
                              </p>
                            </div>
                          </div>
                          <Button
                            variant="outline"
                            size="icon"
                            onClick={handleCopyLatestError}
                            aria-label="Copy latest error"
                            title="Copy latest error"
                          >
                            <Copy className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <div className="rounded-3xl border border-border/70 bg-muted/20 p-5">
                        <p className="text-sm font-medium">No captured errors in this session.</p>
                        <p className="mt-2 text-sm text-muted-foreground">
                          Warnings, query failures, render crashes, unhandled promise rejections, and error toasts will
                          appear here automatically.
                        </p>
                      </div>
                    )}

                    <div className="rounded-3xl border border-border/70 bg-muted/20 p-5">
                      <p className="text-sm font-medium">Current diagnostics context</p>
                      <pre className="mt-3 whitespace-pre-wrap break-words text-[11px] text-muted-foreground">
                        {formatJson(diagnostics.context)}
                      </pre>
                    </div>
                  </div>
                </ScrollArea>
              </TabsContent>

              <TabsContent value="events" className="min-h-0 flex-1">
                <ScrollArea className="h-[calc(100vh-18rem)] pr-4">
                  <div className="space-y-3 pb-6">
                    {diagnostics.events.length > 0 ? (
                      diagnostics.events.map((event) => <EventRow key={event.id} event={event} />)
                    ) : (
                      <div className="rounded-3xl border border-dashed border-border/70 p-8 text-sm text-muted-foreground">
                        No diagnostics captured yet.
                      </div>
                    )}
                  </div>
                </ScrollArea>
              </TabsContent>

              <TabsContent value="report" className="min-h-0 flex-1">
                <ScrollArea className="h-[calc(100vh-18rem)] rounded-3xl border border-border/70 bg-muted/20 p-4">
                  <pre className="whitespace-pre-wrap break-words text-[11px] text-muted-foreground">
                    {reportText}
                  </pre>
                </ScrollArea>
              </TabsContent>
            </Tabs>
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
