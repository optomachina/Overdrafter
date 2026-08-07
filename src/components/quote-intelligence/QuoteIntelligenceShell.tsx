import { type ReactNode, useEffect, useRef, useState } from "react";
import { NavLink, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import {
  Box,
  FileText,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightOpen,
  Search,
} from "lucide-react";
import { OverDrafterMark } from "@/components/OverDrafterMark";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

type QuoteIntelligenceShellProps = {
  readonly title: string;
  readonly eyebrow?: string;
  readonly description?: string;
  readonly uploadSlot?: ReactNode;
  readonly accountSlot?: ReactNode;
  readonly inspector?: ReactNode;
  readonly inspectorTitle?: string;
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
const INSPECTOR_WIDTH = 336;
const SHELL_TOOLTIP_CLASS_NAME =
  "z-[100] rounded-[2px] border border-paper-hairline bg-paper-ink px-2 py-1 font-mono text-[10px] uppercase tracking-[0.08em] text-paper shadow-none";

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

type DestinationNavigationProps = Readonly<{
  collapsed: boolean;
  onNavigate?: () => void;
}>;

function DestinationNavigation({ collapsed, onNavigate }: DestinationNavigationProps) {
  const location = useLocation();

  return (
    <nav aria-label="Primary" className="flex flex-col gap-1 p-2">
      {DESTINATIONS.map(({ href, label, icon: Icon }) => {
        const active = location.pathname === href || location.pathname.startsWith(`${href}/`);
        const link = (
          <NavLink
            to={href}
            aria-current={active ? "page" : undefined}
            onClick={onNavigate}
            className={cn(
              "group relative grid h-10 w-full grid-cols-[36px_minmax(0,1fr)] items-center overflow-hidden rounded-[2px] px-0 text-[13px] font-medium text-paper-muted transition-colors hover:bg-paper-inset hover:text-paper-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-paper-red",
              active && "bg-paper-inset text-paper-ink",
            )}
          >
            {active ? <span className="absolute inset-y-2 left-0 w-0.5 bg-paper-red" aria-hidden="true" /> : null}
            <span className="grid h-9 w-9 place-items-center">
              <Icon className="h-4 w-4" aria-hidden="true" data-navigation-icon={label} />
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

        return (
          <Tooltip key={href}>
            <TooltipTrigger asChild>{link}</TooltipTrigger>
            {collapsed ? (
              <TooltipContent side="right" sideOffset={8} className={SHELL_TOOLTIP_CLASS_NAME}>
                {label}
              </TooltipContent>
            ) : null}
          </Tooltip>
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
      className="hidden h-svh shrink-0 overflow-hidden border-r border-paper-hairline bg-paper transition-[width] duration-200 ease-out md:block"
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
            "absolute right-2 grid h-9 w-9 place-items-center rounded-[2px] text-paper-muted transition-[color,background-color,opacity] duration-150 hover:bg-paper-inset hover:text-paper-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-paper-red",
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

type MobileNavigationProps = Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
}>;

function MobileNavigation({ open, onOpenChange }: MobileNavigationProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="left"
        aria-describedby={undefined}
        className="w-[224px] max-w-[calc(100vw-32px)] gap-0 border-paper-hairline bg-paper p-0 text-paper-ink shadow-none [&>button]:rounded-[2px]"
      >
        <SheetHeader className="h-14 justify-center border-b border-paper-hairline px-3 text-left">
          <SheetTitle className="font-display text-[14px] font-bold uppercase tracking-[-0.04em]">
            OverDrafter
          </SheetTitle>
        </SheetHeader>
        <DestinationNavigation collapsed={false} onNavigate={() => onOpenChange(false)} />
      </SheetContent>
    </Sheet>
  );
}

type WorkspaceHeaderProps = Readonly<{
  accountSlot?: ReactNode;
  hasInspector: boolean;
  isIosApp: boolean;
  onOpenInspector: () => void;
  onOpenMobileNavigation: () => void;
  title: string;
  uploadSlot?: ReactNode;
}>;

function WorkspaceHeader({
  accountSlot,
  hasInspector,
  isIosApp,
  onOpenInspector,
  onOpenMobileNavigation,
  title,
  uploadSlot,
}: WorkspaceHeaderProps) {
  return (
    <header className="relative z-40 flex h-14 shrink-0 items-center gap-3 border-b border-paper-hairline bg-paper px-3 sm:px-4">
      {!isIosApp ? (
        <button
          type="button"
          aria-label="Open navigation"
          onClick={onOpenMobileNavigation}
          className="grid h-9 w-9 shrink-0 place-items-center rounded-[2px] text-paper-muted hover:bg-paper-inset hover:text-paper-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-paper-red md:hidden"
        >
          <PanelLeftOpen className="h-4 w-4" aria-hidden="true" />
        </button>
      ) : (
        <NavLink
          to="/parts?app=ios"
          className="shrink-0 font-display text-[14px] font-bold uppercase tracking-[-0.04em] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-paper-red"
        >
          OverDrafter
        </NavLink>
      )}

      <h1 className="min-w-0 truncate font-mono text-[11px] font-medium uppercase tracking-[0.08em] text-paper-ink">
        {title}
      </h1>

      <div className="ml-auto flex min-w-0 items-center gap-2">
        {uploadSlot}
        {hasInspector ? (
          <button
            type="button"
            aria-label="Open inspector"
            onClick={onOpenInspector}
            className="grid h-9 w-9 shrink-0 place-items-center rounded-[2px] text-paper-muted hover:bg-paper-inset hover:text-paper-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-paper-red xl:hidden"
          >
            <PanelRightOpen className="h-4 w-4" aria-hidden="true" />
          </button>
        ) : null}
        {accountSlot}
      </div>
    </header>
  );
}

type InspectorProps = Readonly<{
  children: ReactNode;
  title: string;
}>;

function DesktopInspector({ children, title }: InspectorProps) {
  return (
    <aside
      aria-label={title}
      data-workspace-inspector="desktop"
      className="hidden h-full shrink-0 flex-col overflow-hidden border-l border-paper-hairline bg-paper xl:flex"
      style={{ width: `${INSPECTOR_WIDTH}px` }}
    >
      <div className="flex h-14 shrink-0 items-center border-b border-paper-hairline px-4">
        <h2 className="truncate font-mono text-[10px] uppercase tracking-[0.08em] text-paper-muted">{title}</h2>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4">{children}</div>
    </aside>
  );
}

type MobileInspectorProps = InspectorProps & Readonly<{
  onOpenChange: (open: boolean) => void;
  open: boolean;
}>;

function MobileInspector({ children, onOpenChange, open, title }: MobileInspectorProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        aria-describedby={undefined}
        data-workspace-inspector="sheet"
        className="w-[336px] max-w-[calc(100vw-32px)] gap-0 border-paper-hairline bg-paper p-0 text-paper-ink shadow-none sm:max-w-[336px] [&>button]:rounded-[2px] xl:hidden"
      >
        <SheetHeader className="h-14 justify-center border-b border-paper-hairline px-4 text-left">
          <SheetTitle className="font-mono text-[10px] font-medium uppercase tracking-[0.08em] text-paper-muted">
            {title}
          </SheetTitle>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4">{children}</div>
      </SheetContent>
    </Sheet>
  );
}

export function QuoteIntelligenceShell({
  title,
  eyebrow,
  description,
  uploadSlot,
  accountSlot,
  inspector,
  inspectorTitle = "Inspector",
  children,
  contentClassName,
}: QuoteIntelligenceShellProps) {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const isIosApp = searchParams.get("app") === "ios";
  const [sidebarCollapsed, setSidebarCollapsed] = useSidebarCollapseState();
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);
  const [mobileInspectorOpen, setMobileInspectorOpen] = useState(false);
  const hasInspector = inspector != null;

  return (
    <TooltipProvider delayDuration={120}>
      <div className="flex h-svh overflow-hidden bg-paper text-paper-ink" data-client-shell>
        {isIosApp ? null : (
          <DesktopSidebar
            collapsed={sidebarCollapsed}
            onCollapse={() => setSidebarCollapsed(true)}
            onExpand={() => setSidebarCollapsed(false)}
            onGoHome={() => navigate("/")}
          />
        )}

        <div className="flex min-w-0 flex-1 flex-col">
          <MobileNavigation
            open={mobileNavigationOpen}
            onOpenChange={setMobileNavigationOpen}
          />
          <WorkspaceHeader
            accountSlot={accountSlot}
            hasInspector={hasInspector}
            isIosApp={isIosApp}
            onOpenInspector={() => setMobileInspectorOpen(true)}
            onOpenMobileNavigation={() => setMobileNavigationOpen(true)}
            title={title}
            uploadSlot={uploadSlot}
          />

          <div className="flex min-h-0 min-w-0 flex-1">
            <main
              data-workspace-scroll="primary"
              className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain"
            >
              <div
                className={cn(
                  "mx-auto w-full max-w-[1440px] px-4 pb-12 pt-6 sm:px-6 md:pt-8",
                  contentClassName,
                )}
              >
                {eyebrow || description ? (
                  <div className="mb-5 border-b border-paper-hairline pb-4">
                    {eyebrow ? (
                      <p className="font-mono text-[10px] uppercase tracking-[0.08em] text-paper-muted">{eyebrow}</p>
                    ) : null}
                    {description ? <p className="mt-2 max-w-3xl text-[13px] text-paper-muted">{description}</p> : null}
                  </div>
                ) : null}
                {children}
              </div>
            </main>

            {hasInspector ? <DesktopInspector title={inspectorTitle}>{inspector}</DesktopInspector> : null}
          </div>
        </div>

        {hasInspector ? (
          <MobileInspector
            open={mobileInspectorOpen}
            onOpenChange={setMobileInspectorOpen}
            title={inspectorTitle}
          >
            {inspector}
          </MobileInspector>
        ) : null}
      </div>
    </TooltipProvider>
  );
}
