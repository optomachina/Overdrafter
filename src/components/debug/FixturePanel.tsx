import { useEffect, useMemo, useState } from "react";
import { FlaskConical } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  CLIENT_WORKSPACE_FIXTURE_SCENARIOS,
  getFixtureScenarioIdFromSearch,
  isFixtureModeAvailable,
} from "@/features/quotes/client-workspace-fixtures";
import { Button } from "@/components/ui/button";

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

export function FixturePanel() {
  const location = useLocation();
  const navigate = useNavigate();
  const activeScenarioId = getFixtureScenarioIdFromSearch(location.search);
  const activeScenario = CLIENT_WORKSPACE_FIXTURE_SCENARIOS.find(
    (scenario) => scenario.id === activeScenarioId,
  );
  const [open, setOpen] = useState(Boolean(activeScenario));

  useEffect(() => {
    _openFixturePanel = () => setOpen(true);
    return () => {
      _openFixturePanel = null;
    };
  }, []);
  const params = useMemo(() => new URLSearchParams(location.search), [location.search]);

  useEffect(() => {
    if (activeScenario) {
      setOpen(true);
    }
  }, [activeScenario]);

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

  if (!open) {
    return null;
  }

  const handleExit = () => {
    setOpen(false);
    navigate(exitHref, { replace: true });
  };

  return (
    <section
      aria-label="Fixture controls"
      className="shrink-0 border-b border-paper-hairline bg-paper-surface text-paper-ink"
      data-fixture-panel
    >
      <div className="mx-auto flex min-h-11 w-full max-w-[1440px] flex-wrap items-center gap-2 px-4 py-2 sm:px-6">
        <div className="mr-auto flex min-w-0 items-center gap-2">
          <FlaskConical className="h-4 w-4 shrink-0 text-paper-muted" aria-hidden="true" />
          <span className="font-mono text-[10px] font-medium uppercase tracking-[0.08em] text-paper-muted">
            Fixture
          </span>
          {activeScenario ? (
            <span className="truncate text-[12px] font-medium text-paper-ink">
              {activeScenario.label}
            </span>
          ) : null}
        </div>

        <label>
          <span className="sr-only">Fixture scenario</span>
          <select
            aria-label="Fixture scenario"
            className="h-8 rounded-[2px] border border-paper-hairline bg-paper px-2 text-[12px] text-paper-ink outline-none focus:border-paper-red focus:ring-1 focus:ring-paper-red"
            value={activeScenarioId ?? ""}
            onChange={(event) => {
              const scenario = CLIENT_WORKSPACE_FIXTURE_SCENARIOS.find(
                (candidate) => candidate.id === event.target.value,
              );
              if (scenario) {
                navigate(appendDebugQuery(scenario.canonicalPath, location.search));
              }
            }}
          >
            <option value="" disabled>
              Choose scenario
            </option>
            {CLIENT_WORKSPACE_FIXTURE_SCENARIOS.map((scenario) => (
              <option key={scenario.id} value={scenario.id}>
                {scenario.label}
              </option>
            ))}
          </select>
        </label>

        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-8 rounded-[2px] px-2 text-[12px] text-paper-muted hover:bg-paper-inset hover:text-paper-ink"
          onClick={() => navigate(appendDebugQuery("/debug/state-gallery", location.search))}
        >
          State gallery
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-8 rounded-[2px] border-paper-hairline bg-paper px-2 text-[12px] text-paper-ink hover:bg-paper-inset"
          onClick={handleExit}
        >
          Exit
        </Button>
      </div>
    </section>
  );
}
