import { type ReactNode, useEffect, useState } from "react";
import { NavLink, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { Box, FileText, PanelLeftClose, PanelLeftOpen, Search } from "lucide-react";
import { OverDrafterMark } from "@/components/OverDrafterMark";
import { cn } from "@/lib/utils";

type QuoteIntelligenceShellProps = {
  title: string;
  eyebrow?: string;
  description?: string;
  uploadSlot?: ReactNode;
  accountSlot?: ReactNode;
  children: ReactNode;
  contentClassName?: string;
};

const DESTINATIONS = [
  { href: "/parts", label: "Parts", icon: Box },
  { href: "/quotes", label: "Quotes", icon: FileText },
  { href: "/search", label: "Search", icon: Search },
] as const;

const DESKTOP_SIDEBAR_COLLAPSED_STORAGE_KEY = "workspace-shell.desktop-collapsed-v1";
const SIDEBAR_EXPANDED_WIDTH = 224;
const SIDEBAR_COLLAPSED_WIDTH = 52;

function readSidebarCollapsed() {
  try {
    if (globalThis.window === undefined) {
      return false;
    }

    if (globalThis.window.matchMedia?.("(max-width: 767px)").matches) {
      return true;
    }

    return globalThis.window.localStorage.getItem(DESKTOP_SIDEBAR_COLLAPSED_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function DestinationNavigation({ collapsed }: Readonly<{ collapsed: boolean }>) {
  const location = useLocation();

  return (
    <nav aria-label="Primary" className="flex flex-col gap-1 p-2">
      {DESTINATIONS.map(({ href, label, icon: Icon }) => {
        const active = location.pathname === href || location.pathname.startsWith(`${href}/`);

        return (
          <NavLink
            key={href}
            to={href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "group relative grid h-10 w-full grid-cols-[36px_minmax(0,1fr)] items-center overflow-hidden rounded px-0 text-[13px] font-medium text-paper-muted transition-colors hover:bg-paper-inset hover:text-paper-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-paper-red",
              active && "bg-paper-inset text-paper-ink",
            )}
          >
            {active ? <span className="absolute inset-y-2 left-0 w-0.5 bg-paper-red" aria-hidden="true" /> : null}
            <span className="grid h-9 w-9 place-items-center">
              <Icon className="h-4 w-4" aria-hidden="true" />
            </span>
            <span
              className={cn(
                "overflow-hidden whitespace-nowrap pr-3 transition-opacity duration-150",
                collapsed ? "opacity-0" : "opacity-100",
              )}
            >
              {label}
            </span>
          </NavLink>
        );
      })}
    </nav>
  );
}

export function QuoteIntelligenceShell({
  title,
  eyebrow,
  description,
  uploadSlot,
  accountSlot,
  children,
  contentClassName,
}: QuoteIntelligenceShellProps) {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const isIosApp = searchParams.get("app") === "ios";
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => readSidebarCollapsed());

  useEffect(() => {
    try {
      globalThis.window.localStorage.setItem(
        DESKTOP_SIDEBAR_COLLAPSED_STORAGE_KEY,
        sidebarCollapsed ? "1" : "0",
      );
    } catch {
      // Ignore storage failures in private browsing and restricted contexts.
    }
  }, [sidebarCollapsed]);

  const sidebarWidth = sidebarCollapsed ? SIDEBAR_COLLAPSED_WIDTH : SIDEBAR_EXPANDED_WIDTH;

  return (
    <div
      className={cn(
        "min-h-svh bg-paper text-paper-ink",
        !isIosApp && "transition-[padding-left] duration-200 ease-out",
      )}
      style={{ paddingLeft: isIosApp ? undefined : `${sidebarWidth}px` }}
    >
      {!isIosApp ? (
        <aside
          data-state={sidebarCollapsed ? "collapsed" : "expanded"}
          className="fixed inset-y-0 left-0 z-50 overflow-hidden border-r border-paper-hairline bg-paper transition-[width] duration-200 ease-out"
          style={{ width: `${sidebarWidth}px` }}
        >
          <div className="relative flex h-14 items-center border-b border-paper-hairline px-2">
            <button
              type="button"
              aria-label={sidebarCollapsed ? "Open sidebar" : "OverDrafter home"}
              aria-expanded={sidebarCollapsed ? false : undefined}
              onClick={() => {
                if (sidebarCollapsed) {
                  setSidebarCollapsed(false);
                  return;
                }
                navigate("/");
              }}
              className="group flex h-9 min-w-0 flex-1 items-center overflow-hidden pr-11 font-display text-[14px] font-bold uppercase tracking-[-0.04em] text-paper-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-paper-red"
            >
              <span className="relative grid h-9 w-9 shrink-0 place-items-center">
                <OverDrafterMark
                  className={cn(
                    "h-6 w-6 transition-opacity duration-150",
                    sidebarCollapsed && "group-hover:opacity-0 group-focus-visible:opacity-0",
                  )}
                />
                <PanelLeftOpen
                  className={cn(
                    "pointer-events-none absolute h-4 w-4 opacity-0 transition-opacity duration-150",
                    sidebarCollapsed && "group-hover:opacity-100 group-focus-visible:opacity-100",
                  )}
                />
              </span>
              <span
                className={cn(
                  "truncate transition-opacity duration-150",
                  sidebarCollapsed ? "opacity-0" : "opacity-100",
                )}
              >
                OverDrafter
              </span>
            </button>
            <button
              type="button"
              aria-label="Close sidebar"
              aria-expanded={sidebarCollapsed ? undefined : true}
              aria-hidden={sidebarCollapsed || undefined}
              tabIndex={sidebarCollapsed ? -1 : undefined}
              onClick={() => setSidebarCollapsed(true)}
              className={cn(
                "absolute right-2 grid h-9 w-9 place-items-center rounded text-paper-muted transition-[color,background-color,opacity] duration-150 hover:bg-paper-inset hover:text-paper-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-paper-red",
                sidebarCollapsed ? "pointer-events-none opacity-0" : "opacity-100",
              )}
            >
              <PanelLeftClose className="h-4 w-4" />
            </button>
          </div>
          <DestinationNavigation collapsed={sidebarCollapsed} />
        </aside>
      ) : null}

      <header className="sticky top-0 z-40 border-b border-paper-hairline bg-paper/95 backdrop-blur-sm">
        <div className="mx-auto flex h-14 w-full max-w-[1440px] items-center gap-4 px-4 sm:px-6">
          {isIosApp ? (
            <NavLink
              to="/parts?app=ios"
              className="shrink-0 font-display text-[14px] font-bold uppercase tracking-[-0.04em] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-paper-red"
            >
              OverDrafter
            </NavLink>
          ) : (
            <span className="truncate font-mono text-[10px] uppercase tracking-[0.08em] text-paper-muted">{title}</span>
          )}
          <div className="ml-auto flex min-w-0 items-center gap-2">
            {uploadSlot}
            {accountSlot}
          </div>
        </div>
      </header>

      <main
        className={cn(
          "mx-auto w-full max-w-[1440px] px-4 pb-12 pt-8 sm:px-6 md:pt-10",
          contentClassName,
        )}
      >
        <div className="mb-7 border-b border-paper-hairline pb-5">
          {eyebrow ? (
            <p className="mb-2 font-mono text-micro uppercase text-paper-muted">{eyebrow}</p>
          ) : null}
          <h1 className="font-display text-[30px] font-bold leading-none tracking-[-0.04em] sm:text-[38px]">
            {title}
          </h1>
          {description ? <p className="mt-3 max-w-2xl text-body-sm text-paper-muted">{description}</p> : null}
        </div>
        {children}
      </main>
    </div>
  );
}
