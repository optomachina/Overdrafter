import { type ReactNode, useEffect, useRef, useState } from "react";
import { NavLink, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { Box, FileText, PanelLeftClose, PanelLeftOpen, Search } from "lucide-react";
import { OverDrafterMark } from "@/components/OverDrafterMark";
import { cn } from "@/lib/utils";

type QuoteIntelligenceShellProps = {
  readonly title: string;
  readonly eyebrow?: string;
  readonly description?: string;
  readonly uploadSlot?: ReactNode;
  readonly accountSlot?: ReactNode;
  readonly children: ReactNode;
  readonly contentClassName?: string;
};

const DESTINATIONS = [
  { href: "/parts", label: "Parts", icon: Box },
  { href: "/quotes", label: "Quotes", icon: FileText },
  { href: "/search", label: "Search", icon: Search },
] as const;

const DESKTOP_SIDEBAR_COLLAPSED_STORAGE_KEY = "workspace-shell.desktop-collapsed-v1";
const SIDEBAR_EXPANDED_WIDTH = 224;
const SIDEBAR_COLLAPSED_WIDTH = 52;

function readDesktopSidebarCollapsed() {
  try {
    if (globalThis.window === undefined) {
      return false;
    }
    return globalThis.window.localStorage.getItem(DESKTOP_SIDEBAR_COLLAPSED_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function readNarrowViewport() {
  return globalThis.window !== undefined &&
    globalThis.window.matchMedia?.("(max-width: 767px)").matches === true;
}

function persistDesktopSidebarCollapsed(collapsed: boolean) {
  try {
    globalThis.window.localStorage.setItem(
      DESKTOP_SIDEBAR_COLLAPSED_STORAGE_KEY,
      collapsed ? "1" : "0",
    );
  } catch {
    // Ignore storage failures in private browsing and restricted contexts.
  }
}

function useSidebarCollapseState() {
  const [desktopPreference] = useState(() => readDesktopSidebarCollapsed());
  const desktopPreferenceRef = useRef(desktopPreference);
  const narrowViewportRef = useRef(readNarrowViewport());
  const [collapsed, setCollapsed] = useState(
    () => narrowViewportRef.current || desktopPreferenceRef.current,
  );

  useEffect(() => {
    if (!globalThis.window?.matchMedia) {
      return;
    }

    const mediaQuery = globalThis.window.matchMedia("(max-width: 767px)");
    const handleViewportChange = (event: MediaQueryListEvent) => {
      narrowViewportRef.current = event.matches;
      setCollapsed(event.matches ? true : desktopPreferenceRef.current);
    };

    narrowViewportRef.current = mediaQuery.matches;
    setCollapsed(mediaQuery.matches ? true : desktopPreferenceRef.current);
    mediaQuery.addEventListener?.("change", handleViewportChange);

    return () => mediaQuery.removeEventListener?.("change", handleViewportChange);
  }, []);

  const setCollapsedFromUser = (nextCollapsed: boolean) => {
    setCollapsed(nextCollapsed);
    if (!narrowViewportRef.current) {
      desktopPreferenceRef.current = nextCollapsed;
      persistDesktopSidebarCollapsed(nextCollapsed);
    }
  };

  return [collapsed, setCollapsedFromUser] as const;
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

type DesktopSidebarProps = Readonly<{
  collapsed: boolean;
  onCollapse: () => void;
  onExpand: () => void;
  onGoHome: () => void;
}>;

function DesktopSidebar({ collapsed, onCollapse, onExpand, onGoHome }: DesktopSidebarProps) {
  const handleBrandClick = () => {
    if (collapsed) {
      onExpand();
      return;
    }

    onGoHome();
  };

  return (
    <aside
      data-state={collapsed ? "collapsed" : "expanded"}
      className="fixed inset-y-0 left-0 z-50 overflow-hidden border-r border-paper-hairline bg-paper transition-[width] duration-200 ease-out"
      style={{ width: `${collapsed ? SIDEBAR_COLLAPSED_WIDTH : SIDEBAR_EXPANDED_WIDTH}px` }}
    >
      <div className="relative flex h-14 items-center border-b border-paper-hairline px-2">
        <button
          type="button"
          aria-label={collapsed ? "Open sidebar" : "OverDrafter home"}
          aria-expanded={collapsed ? false : undefined}
          onClick={handleBrandClick}
          className="group flex h-9 min-w-0 flex-1 items-center overflow-hidden pr-11 font-display text-[14px] font-bold uppercase tracking-[-0.04em] text-paper-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-paper-red"
        >
          <span className="relative grid h-9 w-9 shrink-0 place-items-center">
            <OverDrafterMark
              className={cn(
                "h-6 w-6 transition-opacity duration-150",
                collapsed && "group-hover:opacity-0 group-focus-visible:opacity-0",
              )}
            />
            <PanelLeftOpen
              className={cn(
                "pointer-events-none absolute h-4 w-4 opacity-0 transition-opacity duration-150",
                collapsed && "group-hover:opacity-100 group-focus-visible:opacity-100",
              )}
            />
          </span>
          <span
            className={cn(
              "truncate transition-opacity duration-150",
              collapsed ? "opacity-0" : "opacity-100",
            )}
          >
            OverDrafter
          </span>
        </button>
        <button
          type="button"
          aria-label="Close sidebar"
          aria-expanded={collapsed ? undefined : true}
          aria-hidden={collapsed || undefined}
          tabIndex={collapsed ? -1 : undefined}
          onClick={onCollapse}
          className={cn(
            "absolute right-2 grid h-9 w-9 place-items-center rounded text-paper-muted transition-[color,background-color,opacity] duration-150 hover:bg-paper-inset hover:text-paper-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-paper-red",
            collapsed ? "pointer-events-none opacity-0" : "opacity-100",
          )}
        >
          <PanelLeftClose className="h-4 w-4" />
        </button>
      </div>
      <DestinationNavigation collapsed={collapsed} />
    </aside>
  );
}

type WorkspaceHeaderProps = Readonly<{
  accountSlot?: ReactNode;
  isIosApp: boolean;
  title: string;
  uploadSlot?: ReactNode;
}>;

function WorkspaceHeader({ accountSlot, isIosApp, title, uploadSlot }: WorkspaceHeaderProps) {
  return (
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
  );
}

function WorkspaceHeading({
  description,
  eyebrow,
  title,
}: Readonly<Pick<QuoteIntelligenceShellProps, "description" | "eyebrow" | "title">>) {
  return (
    <div className="mb-7 border-b border-paper-hairline pb-5">
      {eyebrow ? (
        <p className="mb-2 font-mono text-micro uppercase text-paper-muted">{eyebrow}</p>
      ) : null}
      <h1 className="font-display text-[30px] font-bold leading-none tracking-[-0.04em] sm:text-[38px]">
        {title}
      </h1>
      {description ? <p className="mt-3 max-w-2xl text-body-sm text-paper-muted">{description}</p> : null}
    </div>
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
  const [sidebarCollapsed, setSidebarCollapsed] = useSidebarCollapseState();

  const sidebarWidth = sidebarCollapsed ? SIDEBAR_COLLAPSED_WIDTH : SIDEBAR_EXPANDED_WIDTH;

  return (
    <div
      className={cn(
        "min-h-svh bg-paper text-paper-ink",
        !isIosApp && "transition-[padding-left] duration-200 ease-out",
      )}
      style={{ paddingLeft: isIosApp ? undefined : `${sidebarWidth}px` }}
    >
      {isIosApp ? null : (
        <DesktopSidebar
          collapsed={sidebarCollapsed}
          onCollapse={() => setSidebarCollapsed(true)}
          onExpand={() => setSidebarCollapsed(false)}
          onGoHome={() => navigate("/")}
        />
      )}

      <WorkspaceHeader
        accountSlot={accountSlot}
        isIosApp={isIosApp}
        title={title}
        uploadSlot={uploadSlot}
      />

      <main
        className={cn(
          "mx-auto w-full max-w-[1440px] px-4 pb-12 pt-8 sm:px-6 md:pt-10",
          contentClassName,
        )}
      >
        <WorkspaceHeading description={description} eyebrow={eyebrow} title={title} />
        {children}
      </main>
    </div>
  );
}
