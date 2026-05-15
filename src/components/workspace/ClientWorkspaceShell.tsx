import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { PanelLeftOpen, PanelRightClose, PanelRightOpen, Sidebar, type LucideIcon } from "lucide-react";
import logoMark from "@/assets/logo-mark.svg";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

const DESKTOP_SIDEBAR_COLLAPSED_STORAGE_KEY = "workspace-shell.desktop-collapsed-v1";
const LEGACY_DESKTOP_SIDEBAR_COLLAPSED_STORAGE_KEY = "chat-workspace-layout.desktop-collapsed-v1";
const DESKTOP_SIDEBAR_WIDTH_STORAGE_KEY = "workspace-shell.desktop-width-v1";
const DESKTOP_SIDEBAR_DEFAULT_WIDTH = 260;
const DESKTOP_SIDEBAR_MIN_WIDTH = 180;
const DESKTOP_SIDEBAR_MAX_WIDTH = 480;
const DESKTOP_SIDEBAR_COLLAPSED_WIDTH = "52px";
const SIDEBAR_TOOLTIP_DELAY_MS = 120;
const CURSOR_TOOLTIP_OFFSET = 14;
const SIDEBAR_HEADER_INSET_CLASS = "px-2";
const SIDEBAR_LOGO_VISUAL_OFFSET_CLASS = "translate-x-[5px]";
const SIDEBAR_ICON_TOOLTIP_CLASS_NAME =
  "workspace-shell rounded-lg border-transparent bg-ws-deep px-2.5 py-1.5 text-[11px] font-medium text-foreground shadow-[0_10px_30px_rgba(0,0,0,0.45)]";
const BRAND_NAME = "OverDrafter";

const DESKTOP_RIGHT_RAIL_COLLAPSED_STORAGE_KEY = "workspace-shell.right-rail-collapsed-v1";
const DESKTOP_RIGHT_RAIL_WIDTH = 288;
const DESKTOP_RIGHT_RAIL_COLLAPSED_WIDTH = "32px";

function readDesktopRightRailCollapsed() {
  try {
    if (globalThis.window === undefined) {
      return false;
    }
    return globalThis.window.localStorage.getItem(DESKTOP_RIGHT_RAIL_COLLAPSED_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function readDesktopSidebarCollapsed() {
  try {
    if (globalThis.window === undefined) {
      return false;
    }

    const value =
      globalThis.window.localStorage.getItem(DESKTOP_SIDEBAR_COLLAPSED_STORAGE_KEY) ??
      globalThis.window.localStorage.getItem(LEGACY_DESKTOP_SIDEBAR_COLLAPSED_STORAGE_KEY);

    if (value !== null) {
      globalThis.window.localStorage.setItem(DESKTOP_SIDEBAR_COLLAPSED_STORAGE_KEY, value);
      globalThis.window.localStorage.removeItem(LEGACY_DESKTOP_SIDEBAR_COLLAPSED_STORAGE_KEY);
    }

    return value === "1";
  } catch {
    return false;
  }
}

function readDesktopSidebarWidth() {
  try {
    if (globalThis.window === undefined) {
      return DESKTOP_SIDEBAR_DEFAULT_WIDTH;
    }
    const value = globalThis.window.localStorage.getItem(DESKTOP_SIDEBAR_WIDTH_STORAGE_KEY);
    if (value === null) return DESKTOP_SIDEBAR_DEFAULT_WIDTH;
    const parsed = parseInt(value, 10);
    if (!Number.isFinite(parsed)) return DESKTOP_SIDEBAR_DEFAULT_WIDTH;
    return Math.min(DESKTOP_SIDEBAR_MAX_WIDTH, Math.max(DESKTOP_SIDEBAR_MIN_WIDTH, parsed));
  } catch {
    return DESKTOP_SIDEBAR_DEFAULT_WIDTH;
  }
}

export type SidebarRailAction = {
  label: string;
  icon: LucideIcon;
  onClick: () => void;
  isActive?: boolean;
  disabled?: boolean;
};

type ClientWorkspaceShellProps = {
  topRightContent?: ReactNode;
  headerContent?: ReactNode;
  sidebarContent: ReactNode;
  sidebarFooter?: ReactNode;
  sidebarRailActions?: SidebarRailAction[];
  showSidebar?: boolean;
  onLogoClick?: () => void;
  /**
   * Optional collapsible right rail — the PART INFO / PROJECT INFO panel and
   * ROADMAP chips per docs/DESIGN.md §Layout. Only rendered when provided, so
   * routes that don't pass it (most internal pages) are unaffected.
   */
  rightRailContent?: ReactNode;
  rightRailFooter?: ReactNode;
  rightRailLabel?: string;
  children: ReactNode;
};

type SidebarIconButtonProps = {
  label: string;
  icon: LucideIcon;
  onClick: () => void;
  isActive?: boolean;
  disabled?: boolean;
  ariaExpanded?: boolean;
  className?: string;
  tooltipMode?: "side" | "cursor";
};

function SidebarIconButton({
  label,
  icon: Icon,
  onClick,
  isActive = false,
  disabled = false,
  ariaExpanded,
  className,
  tooltipMode = "side",
}: SidebarIconButtonProps) {
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const pointerDownRef = useRef(false);
  const cursorTooltipTimerRef = useRef<number | null>(null);
  const [isCursorTooltipOpen, setIsCursorTooltipOpen] = useState(false);
  const [cursorTooltipPosition, setCursorTooltipPosition] = useState<{ left: number; top: number } | null>(null);
  const tooltipId = useId();

  const clearCursorTooltipTimer = useCallback(() => {
    if (cursorTooltipTimerRef.current === null) {
      return;
    }

    globalThis.window.clearTimeout(cursorTooltipTimerRef.current);
    cursorTooltipTimerRef.current = null;
  }, []);

  const hideCursorTooltip = useCallback(() => {
    clearCursorTooltipTimer();
    setIsCursorTooltipOpen(false);
  }, [clearCursorTooltipTimer]);

  const handlePointerUp = useCallback(() => {
    pointerDownRef.current = false;
  }, []);

  useEffect(() => {
    return () => {
      clearCursorTooltipTimer();
      globalThis.document.removeEventListener("pointerup", handlePointerUp);
    };
  }, [clearCursorTooltipTimer, handlePointerUp]);

  const updateCursorTooltipPosition = useCallback((left: number, top: number) => {
    if (!Number.isFinite(left) || !Number.isFinite(top)) {
      return;
    }

    setCursorTooltipPosition({
      left,
      top: top + CURSOR_TOOLTIP_OFFSET,
    });
  }, []);

  const updateCursorTooltipFromTrigger = useCallback(() => {
    const rect = buttonRef.current?.getBoundingClientRect();

    if (!rect) {
      return;
    }

    updateCursorTooltipPosition(rect.left + rect.width / 2, rect.bottom);
  }, [updateCursorTooltipPosition]);

  const scheduleCursorTooltipOpen = useCallback(() => {
    if (disabled) {
      return;
    }

    clearCursorTooltipTimer();
    cursorTooltipTimerRef.current = globalThis.window.setTimeout(() => {
      setIsCursorTooltipOpen(true);
      cursorTooltipTimerRef.current = null;
    }, SIDEBAR_TOOLTIP_DELAY_MS);
  }, [clearCursorTooltipTimer, disabled]);

  const button = (
    <button
      ref={buttonRef}
      type="button"
      aria-label={label}
      aria-describedby={tooltipMode === "cursor" && isCursorTooltipOpen ? tooltipId : undefined}
      aria-expanded={ariaExpanded}
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        hideCursorTooltip();
        onClick();
      }}
      onPointerDown={(event) => {
        if (tooltipMode !== "cursor" || event.pointerType === "touch") {
          return;
        }

        pointerDownRef.current = true;
        hideCursorTooltip();
        globalThis.document.addEventListener("pointerup", handlePointerUp, { once: true });
      }}
      onPointerEnter={(event) => {
        if (tooltipMode !== "cursor" || event.pointerType === "touch") {
          return;
        }

        updateCursorTooltipPosition(event.clientX, event.clientY);
        scheduleCursorTooltipOpen();
      }}
      onPointerMove={(event) => {
        if (tooltipMode !== "cursor" || event.pointerType === "touch") {
          return;
        }

        updateCursorTooltipPosition(event.clientX, event.clientY);
      }}
      onPointerLeave={() => {
        if (tooltipMode !== "cursor") {
          return;
        }

        hideCursorTooltip();
      }}
      onFocus={() => {
        if (tooltipMode !== "cursor" || pointerDownRef.current || disabled) {
          return;
        }

        updateCursorTooltipFromTrigger();
        setIsCursorTooltipOpen(true);
      }}
      onBlur={() => {
        if (tooltipMode !== "cursor") {
          return;
        }

        hideCursorTooltip();
      }}
      className={cn(
        "flex h-9 w-9 items-center justify-center rounded border text-foreground/95 transition-colors duration-150",
        isActive
          ? "border-border bg-accent text-foreground"
          : "border-transparent hover:border-border hover:bg-accent hover:text-foreground",
        disabled && "cursor-not-allowed opacity-50",
        className,
      )}
    >
      <Icon className="h-4 w-4" />
    </button>
  );

  if (tooltipMode === "cursor") {
    return (
      <>
        {button}
        {isCursorTooltipOpen && cursorTooltipPosition && globalThis.document !== undefined
          ? createPortal(
              <div
                id={tooltipId}
                role="tooltip"
                className={cn("pointer-events-none fixed z-50 -translate-x-1/2", SIDEBAR_ICON_TOOLTIP_CLASS_NAME)}
                style={{
                  left: cursorTooltipPosition.left,
                  top: cursorTooltipPosition.top,
                }}
              >
                {label}
              </div>,
              globalThis.document.body,
            )
          : null}
      </>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {button}
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={10} className={SIDEBAR_ICON_TOOLTIP_CLASS_NAME}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

function SidebarScaffold({
  sidebarContent,
  sidebarFooter,
  onCollapse,
  onLogoClick,
}: Pick<ClientWorkspaceShellProps, "sidebarContent" | "sidebarFooter"> & {
  onCollapse: () => void;
  onLogoClick?: () => void;
}) {
  return (
    <div className="workspace-shell flex h-full flex-col bg-ws-shell text-foreground">
      <div className={cn("flex items-center justify-between gap-3 pb-3 pt-3", SIDEBAR_HEADER_INSET_CLASS)}>
        {onLogoClick ? (
          <button
            type="button"
            onClick={onLogoClick}
            aria-label={`${BRAND_NAME} home`}
            className="grid h-9 w-9 place-items-center rounded text-left transition hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <img
              src={logoMark}
              alt="OverDrafter logo"
              className={cn("h-6 w-6 object-contain", SIDEBAR_LOGO_VISUAL_OFFSET_CLASS)}
            />
          </button>
        ) : (
          <div className="grid h-9 w-9 place-items-center">
            <img
              src={logoMark}
              alt="OverDrafter logo"
              className={cn("h-6 w-6 object-contain", SIDEBAR_LOGO_VISUAL_OFFSET_CLASS)}
            />
          </div>
        )}

        <SidebarIconButton
          label="Close sidebar"
          icon={Sidebar}
          onClick={onCollapse}
          ariaExpanded
          tooltipMode="cursor"
        />
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">{sidebarContent}</div>

      {sidebarFooter ? <div className="px-3 pb-3 pt-2">{sidebarFooter}</div> : null}
    </div>
  );
}

function CollapsedSidebarRail({
  sidebarRailActions = [],
  onOpen,
}: Pick<ClientWorkspaceShellProps, "sidebarRailActions"> & {
  onOpen: () => void;
}) {
  return (
    <div
      className="workspace-shell group flex h-full cursor-e-resize flex-col items-center gap-3 bg-ws-shell px-2 py-3 text-foreground"
      onClick={onOpen}
    >
      <div className="flex h-9 w-full items-center justify-center">
        <div className="relative h-9 w-9">
          <img
            src={logoMark}
            alt="OverDrafter logo"
            className="h-9 w-9 object-contain p-[6px] transition group-hover:opacity-0 group-focus-within:opacity-0"
          />

          <div className="pointer-events-none absolute inset-0 opacity-0 transition duration-150 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
            <SidebarIconButton
              label="Open sidebar"
              icon={PanelLeftOpen}
              onClick={onOpen}
              ariaExpanded={false}
              className="cursor-e-resize"
            />
          </div>
        </div>
      </div>

      <div className="flex w-full flex-col items-center gap-0.5">
        {sidebarRailActions.map((action) => (
          <SidebarIconButton
            key={action.label}
            label={action.label}
            icon={action.icon}
            onClick={action.onClick}
            isActive={action.isActive}
            disabled={action.disabled}
          />
        ))}
      </div>
    </div>
  );
}

function RightRailScaffold({
  rightRailContent,
  rightRailFooter,
  rightRailLabel,
  onCollapse,
}: Pick<ClientWorkspaceShellProps, "rightRailContent" | "rightRailFooter" | "rightRailLabel"> & {
  onCollapse: () => void;
}) {
  return (
    <div className="workspace-shell flex h-full flex-col bg-ws-shell text-foreground">
      <div className="flex items-center justify-between gap-3 px-3 pb-3 pt-3">
        {rightRailLabel ? (
          <span className="ws-section-label truncate">{rightRailLabel}</span>
        ) : (
          <span />
        )}
        <SidebarIconButton
          label="Close panel"
          icon={PanelRightClose}
          onClick={onCollapse}
          ariaExpanded
          tooltipMode="cursor"
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto sidebar-scroll px-3">{rightRailContent}</div>

      {rightRailFooter ? (
        <div className="border-t border-border px-3 pb-3 pt-3">{rightRailFooter}</div>
      ) : null}
    </div>
  );
}

function CollapsedRightRail({ onOpen }: Readonly<{ onOpen: () => void }>) {
  return (
    <div className="workspace-shell group flex h-full flex-col items-center gap-3 border-l border-border bg-ws-shell px-2 py-3 text-foreground">
      <button
        type="button"
        aria-label="Open panel"
        aria-expanded={false}
        className="flex h-full w-full cursor-w-resize justify-center"
        onClick={onOpen}
      >
        <span className="mt-0 flex h-9 w-9 items-center justify-center rounded border border-transparent text-foreground/95 transition-colors duration-150 hover:border-border hover:bg-accent hover:text-foreground">
          <PanelRightOpen className="h-4 w-4" />
        </span>
      </button>
    </div>
  );
}

type DesktopSidebarRegionProps = Readonly<
  Pick<ClientWorkspaceShellProps, "sidebarContent" | "sidebarFooter" | "sidebarRailActions" | "onLogoClick"> & {
    desktopSidebarCollapsed: boolean;
    isResizing: boolean;
    onCollapse: () => void;
    onOpen: () => void;
    onResizePointerDown: (event: React.PointerEvent) => void;
    sidebarWidth: number;
  }
>;

function DesktopSidebarRegion({
  desktopSidebarCollapsed,
  isResizing,
  onCollapse,
  onLogoClick,
  onOpen,
  onResizePointerDown,
  sidebarContent,
  sidebarFooter,
  sidebarRailActions,
  sidebarWidth,
}: DesktopSidebarRegionProps) {
  return (
    <aside
      className={cn(
        "sidebar-host relative sticky top-0 hidden shrink-0 self-start overflow-visible border-r border-border md:block",
        !isResizing && "transition-[width] duration-200 ease-out",
      )}
      style={{
        width: desktopSidebarCollapsed ? DESKTOP_SIDEBAR_COLLAPSED_WIDTH : `${sidebarWidth}px`,
      }}
    >
      <div className="h-svh">
        <div className={cn("h-full", desktopSidebarCollapsed && "hidden")}>
          <SidebarScaffold
            sidebarContent={sidebarContent}
            sidebarFooter={sidebarFooter}
            onCollapse={onCollapse}
            onLogoClick={onLogoClick}
          />
          <div
            role="separator"
            aria-label="Resize sidebar"
            aria-orientation="vertical"
            className="absolute inset-y-0 right-0 z-20 hidden w-3 translate-x-1/2 cursor-col-resize md:block"
            onPointerDown={onResizePointerDown}
          >
            <div className="absolute inset-y-6 left-1/2 w-px -translate-x-1/2 rounded-full bg-border transition-colors duration-150 hover:bg-muted-foreground" />
          </div>
        </div>
        <div className={cn("h-full", desktopSidebarCollapsed ? "block" : "hidden")}>
          <CollapsedSidebarRail
            sidebarRailActions={sidebarRailActions}
            onOpen={onOpen}
          />
        </div>
      </div>
    </aside>
  );
}

type RightRailRegionProps = Readonly<
  Pick<ClientWorkspaceShellProps, "rightRailContent" | "rightRailFooter" | "rightRailLabel"> & {
    rightRailCollapsed: boolean;
    onCollapse: () => void;
    onOpen: () => void;
  }
>;

function RightRailRegion({
  onCollapse,
  onOpen,
  rightRailCollapsed,
  rightRailContent,
  rightRailFooter,
  rightRailLabel,
}: RightRailRegionProps) {
  return (
    <aside
      className="relative sticky top-0 hidden shrink-0 self-start border-l border-border transition-[width] duration-200 ease-out md:block"
      style={{
        width: rightRailCollapsed
          ? DESKTOP_RIGHT_RAIL_COLLAPSED_WIDTH
          : `${DESKTOP_RIGHT_RAIL_WIDTH}px`,
      }}
    >
      <div className="sidebar-host h-svh">
        <div className={cn("h-full", rightRailCollapsed && "hidden")}>
          <RightRailScaffold
            rightRailContent={rightRailContent}
            rightRailFooter={rightRailFooter}
            rightRailLabel={rightRailLabel}
            onCollapse={onCollapse}
          />
        </div>
        <div className={cn("h-full", rightRailCollapsed ? "block" : "hidden")}>
          <CollapsedRightRail onOpen={onOpen} />
        </div>
      </div>
    </aside>
  );
}

export function ClientWorkspaceShell({
  topRightContent,
  headerContent,
  sidebarContent,
  sidebarFooter,
  sidebarRailActions,
  showSidebar = true,
  onLogoClick,
  rightRailContent,
  rightRailFooter,
  rightRailLabel,
  children,
}: ClientWorkspaceShellProps) {
  const [desktopSidebarCollapsed, setDesktopSidebarCollapsed] = useState(() => readDesktopSidebarCollapsed());
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(() => readDesktopSidebarWidth());
  const [isResizing, setIsResizing] = useState(false);
  const [rightRailCollapsed, setRightRailCollapsed] = useState(() => readDesktopRightRailCollapsed());
  const hasRightRail = rightRailContent != null;
  const resizingRef = useRef(false);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const BrandLabelTag = onLogoClick ? "button" : "div";

  useEffect(() => {
    try {
      globalThis.window.localStorage.setItem(
        DESKTOP_SIDEBAR_COLLAPSED_STORAGE_KEY,
        desktopSidebarCollapsed ? "1" : "0",
      );
    } catch {
      // Ignore storage failures in private browsing and restricted contexts.
    }
  }, [desktopSidebarCollapsed]);

  useEffect(() => {
    try {
      globalThis.window.localStorage.setItem(DESKTOP_SIDEBAR_WIDTH_STORAGE_KEY, String(sidebarWidth));
    } catch {
      // Ignore storage failures.
    }
  }, [sidebarWidth]);

  useEffect(() => {
    try {
      globalThis.window.localStorage.setItem(
        DESKTOP_RIGHT_RAIL_COLLAPSED_STORAGE_KEY,
        rightRailCollapsed ? "1" : "0",
      );
    } catch {
      // Ignore storage failures in private browsing and restricted contexts.
    }
  }, [rightRailCollapsed]);

  useEffect(() => {
    return () => {
      resizeCleanupRef.current?.();
    };
  }, []);

  const handleResizePointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    resizingRef.current = true;
    setIsResizing(true);

    const startX = e.clientX;
    const startWidth = sidebarWidth;

    const onPointerMove = (moveEvent: PointerEvent) => {
      if (!resizingRef.current) return;
      const delta = moveEvent.clientX - startX;
      const newWidth = Math.min(DESKTOP_SIDEBAR_MAX_WIDTH, Math.max(DESKTOP_SIDEBAR_MIN_WIDTH, startWidth + delta));
      setSidebarWidth(newWidth);
    };

    const onPointerUp = () => {
      resizingRef.current = false;
      setIsResizing(false);
      globalThis.document.removeEventListener("pointermove", onPointerMove);
      globalThis.document.removeEventListener("pointerup", onPointerUp);
      resizeCleanupRef.current = null;
    };

    globalThis.document.addEventListener("pointermove", onPointerMove);
    globalThis.document.addEventListener("pointerup", onPointerUp);
    resizeCleanupRef.current = onPointerUp;
  }, [sidebarWidth]);

  return (
    <TooltipProvider delayDuration={SIDEBAR_TOOLTIP_DELAY_MS}>
      <div className={cn("workspace-shell min-h-svh bg-ws-overlay text-foreground", isResizing && "select-none")}>
        <div className="flex min-h-svh">
          {showSidebar ? (
            <DesktopSidebarRegion
              desktopSidebarCollapsed={desktopSidebarCollapsed}
              isResizing={isResizing}
              onCollapse={() => setDesktopSidebarCollapsed(true)}
              onLogoClick={onLogoClick}
              onOpen={() => setDesktopSidebarCollapsed(false)}
              onResizePointerDown={handleResizePointerDown}
              sidebarContent={sidebarContent}
              sidebarFooter={sidebarFooter}
              sidebarRailActions={sidebarRailActions}
              sidebarWidth={sidebarWidth}
            />
          ) : null}

          <div className="relative flex min-h-svh min-w-0 flex-1 flex-col">
            {showSidebar && desktopSidebarCollapsed ? (
              <button
                type="button"
                aria-label="Open sidebar"
                className="absolute inset-y-0 left-0 z-10 hidden w-5 cursor-e-resize bg-transparent md:block"
                onClick={() => setDesktopSidebarCollapsed(false)}
              />
            ) : null}
            <header className="flex flex-wrap items-center gap-3 px-4 py-3 md:flex-nowrap md:justify-between md:px-6">
              {showSidebar ? (
                <Sheet open={mobileSidebarOpen} onOpenChange={setMobileSidebarOpen}>
                  <SheetTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="rounded text-foreground/95 hover:bg-accent hover:text-foreground md:hidden"
                    >
                      <PanelLeftOpen className="h-5 w-5" />
                      <span className="sr-only">Open sidebar</span>
                    </Button>
                  </SheetTrigger>
                  <SheetContent
                    side="left"
                    className="workspace-shell w-[260px] border-r border-border bg-ws-shell p-0 text-foreground sm:max-w-[260px] [&>button]:hidden"
                  >
                    <SidebarScaffold
                      sidebarContent={sidebarContent}
                      sidebarFooter={sidebarFooter}
                      onCollapse={() => setMobileSidebarOpen(false)}
                      onLogoClick={onLogoClick}
                    />
                  </SheetContent>
                </Sheet>
              ) : null}

              <div className="flex min-w-0 flex-1 items-center gap-3">
                <BrandLabelTag
                  {...(onLogoClick
                    ? {
                        type: "button" as const,
                        onClick: onLogoClick,
                      }
                    : {})}
                  className={cn(
                    "flex h-10 min-w-0 items-center text-left",
                    onLogoClick &&
                      "transition hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  )}
                >
                  <span className="block truncate text-[15px] font-medium tracking-[-0.01em] text-foreground/95">
                    {BRAND_NAME}
                  </span>
                </BrandLabelTag>
                {headerContent ? (
                  <>
                    <span className="text-muted-foreground">/</span>
                    <div className="min-w-0 flex-1">{headerContent}</div>
                  </>
                ) : null}
              </div>

              <div className="flex w-full items-center justify-end gap-2 md:ml-auto md:w-auto">{topRightContent}</div>
            </header>

            <main className="flex min-w-0 flex-1 flex-col">{children}</main>
          </div>

          {hasRightRail ? (
            <RightRailRegion
              onCollapse={() => setRightRailCollapsed(true)}
              onOpen={() => setRightRailCollapsed(false)}
              rightRailCollapsed={rightRailCollapsed}
              rightRailContent={rightRailContent}
              rightRailFooter={rightRailFooter}
              rightRailLabel={rightRailLabel}
            />
          ) : null}
        </div>
      </div>
    </TooltipProvider>
  );
}
