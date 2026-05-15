import { useEffect, useMemo, useState } from "react";
import { FlaskConical } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  CLIENT_WORKSPACE_FIXTURE_SCENARIOS,
  getActiveFixtureScenario,
  isFixtureModeAvailable,
} from "@/features/quotes/client-workspace-fixtures";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

function appendDebugQuery(target: string, currentSearch: string): string {
  const params = new URLSearchParams(currentSearch);

  if (!params.has("debug")) {
    return target;
  }

  const url = new URL(target, window.location.origin);
  url.searchParams.set("debug", params.get("debug") ?? "1");
  return `${url.pathname}${url.search}${url.hash}`;
}

let _openFixturePanel: (() => void) | null = null;

export function openFixturePanel() {
  _openFixturePanel?.();
}

export function FixturePanel({ hideFloatingButton = false }: { hideFloatingButton?: boolean }) {
  const location = useLocation();
  const navigate = useNavigate();
  const activeScenario = getActiveFixtureScenario();
  const [open, setOpen] = useState(Boolean(activeScenario));

  useEffect(() => {
    _openFixturePanel = () => setOpen(true);
    return () => {
      _openFixturePanel = null;
    };
  }, []);
  const params = useMemo(() => new URLSearchParams(location.search), [location.search]);

  const visible = isFixtureModeAvailable() && params.get("embed") !== "1";
  const exitHref = useMemo(() => {
    const nextParams = new URLSearchParams(location.search);
    nextParams.delete("fixture");
    const nextSearch = nextParams.toString();
    return `${location.pathname}${nextSearch ? `?${nextSearch}` : ""}${location.hash}`;
  }, [location.hash, location.pathname, location.search]);

  if (!visible) {
    return null;
  }

  return (
    <div className="fixed bottom-20 right-4 z-40 flex max-w-[min(92vw,22rem)] flex-col items-end gap-3">
      {open ? (
        <div className="rounded-3xl border border-border bg-ws-deep/96 p-4 text-foreground shadow-2xl backdrop-blur">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Fixture mode</p>
              <p className="mt-2 text-sm text-foreground/80">
                Jump into repeatable client workspace scenarios without using Supabase.
              </p>
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="rounded-full border-border bg-transparent text-foreground hover:bg-accent"
              onClick={() => navigate(exitHref)}
            >
              Exit
            </Button>
          </div>

          <div className="mt-4 flex flex-col gap-2">
            <button
              type="button"
              className={cn(
                "rounded-2xl border px-4 py-3 text-left transition",
                location.pathname === "/debug/state-gallery"
                  ? "border-border bg-accent"
                  : "border-border bg-accent hover:bg-accent",
              )}
              onClick={() => navigate(appendDebugQuery("/debug/state-gallery", location.search))}
            >
              <p className="text-sm font-medium text-foreground">State gallery</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Review auth, workspace, part, and project fixture surfaces from one page.
              </p>
            </button>

            {CLIENT_WORKSPACE_FIXTURE_SCENARIOS.map((scenario) => (
              <button
                key={scenario.id}
                type="button"
                className={cn(
                  "rounded-2xl border px-4 py-3 text-left transition",
                  activeScenario?.id === scenario.id
                    ? "border-border bg-accent"
                    : "border-border bg-accent hover:bg-accent",
                )}
                onClick={() => navigate(appendDebugQuery(scenario.canonicalPath, location.search))}
              >
                <p className="text-sm font-medium text-foreground">{scenario.label}</p>
                <p className="mt-1 text-xs text-muted-foreground">{scenario.description}</p>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {!hideFloatingButton ? (
        <Button
          type="button"
          size="sm"
          className="w-fit gap-2 rounded-full border border-border bg-ws-deep/92 text-foreground shadow-2xl hover:bg-accent"
          onClick={() => setOpen((current) => !current)}
        >
          <FlaskConical className="h-4 w-4" />
          Fixtures
        </Button>
      ) : null}
    </div>
  );
}
