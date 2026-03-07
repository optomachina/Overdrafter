import type { ErrorInfo, ReactNode } from "react";
import { Component } from "react";
import { AlertTriangle, Copy, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  captureDiagnosticError,
  copyTextToClipboard,
  createDiagnosticClipboardText,
} from "@/lib/diagnostics";
import { toast } from "sonner";

type AppErrorBoundaryProps = {
  children: ReactNode;
};

type AppErrorBoundaryState = {
  error: Error | null;
  errorId: string | null;
};

export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = {
    error: null,
    errorId: null,
  };

  static getDerivedStateFromError(error: Error) {
    return {
      error,
    };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    const errorId = captureDiagnosticError(error, {
      category: "render",
      source: "react.error-boundary",
      handled: false,
      details: {
        componentStack: errorInfo.componentStack,
      },
    });

    this.setState({
      errorId,
    });
  }

  private handleCopyDiagnostics = async () => {
    try {
      await copyTextToClipboard(
        createDiagnosticClipboardText({
          title: "Overdrafter render failure",
          message: this.state.error?.message ?? "Unknown render failure",
        }),
      );
      toast.success("Debug details copied to clipboard.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to copy diagnostics.");
    }
  };

  render() {
    if (!this.state.error) {
      return this.props.children;
    }

    return (
      <div className="flex min-h-[70vh] items-center justify-center px-6 py-12">
        <div className="w-full max-w-2xl rounded-3xl border border-destructive/20 bg-background/95 p-8 shadow-2xl backdrop-blur">
          <div className="flex items-start gap-4">
            <div className="rounded-2xl bg-destructive/10 p-3 text-destructive">
              <AlertTriangle className="h-6 w-6" />
            </div>
            <div className="min-w-0 space-y-4">
              <div className="space-y-2">
                <h2 className="text-2xl font-semibold tracking-tight">The app hit a render failure.</h2>
                <p className="text-sm text-muted-foreground">
                  Diagnostics were captured automatically so the failure can be investigated without reproducing it from
                  scratch.
                </p>
              </div>

              <div className="rounded-2xl border border-border/70 bg-muted/30 p-4">
                <p className="text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground">Error</p>
                <p className="mt-2 break-words text-sm font-medium">{this.state.error.message}</p>
                {this.state.errorId ? (
                  <p className="mt-3 text-xs text-muted-foreground">Reference: {this.state.errorId}</p>
                ) : null}
              </div>

              <div className="flex flex-wrap gap-3">
                <Button onClick={() => window.location.reload()}>
                  <RefreshCw className="mr-2 h-4 w-4" />
                  Reload app
                </Button>
                <Button
                  variant="outline"
                  size="icon"
                  onClick={this.handleCopyDiagnostics}
                  aria-label="Copy debug details"
                  title="Copy debug details"
                >
                  <Copy className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }
}
