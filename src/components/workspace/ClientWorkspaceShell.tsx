import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { PanelLeftOpen, Sidebar, type LucideIcon } from "lucide-react";
import logoMark from "@/assets/logo-mark.svg";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

const DESKTOP_SIDEBAR_COLLAPSED_STORAGE_KEY = "chat-workspace-layout.desktop-collapsed-v1";
const DESKTOP_SIDEBAR_EXPANDED_WIDTH = "260px";
const DESKTOP_SIDEBAR_COLLAPSED_WIDTH = "52px";
const SIDEBAR_TOOLTIP_DELAY_MS = 120;
const CURSOR_TOOLTIP_OFFSET = 14;
const SIDEBAR_ICON_TOOLTIP_CLASS_NAME =
  "workspace-shell rounded-lg border-transparent bg-[#0f0f0f] px-2.5 py-1.5 text-[11px] font-medium text-white shadow-[0_10px_30px_rgba(0,0,0,0.45)]";
const BRAND_NAME = "OverDrafter";

function readDesktopSidebarCollapsed() {
  try {
    if (typeof window === "undefined") {
      return false;
    }

    return window.localStorage.getItem(DESKTOP_SIDEBAR_COLLAPSED_STORAGE_KEY) === "1";
  } catch {
    return false;
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
  sidebarContent: ReactNode;
  sidebarFooter?: ReactNode;
  sidebarRailActions?: SidebarRailAction[];
  onLogoClick?: () => void;
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

    window.clearTimeout(cursorTooltipTimerRef.current);
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
      document.removeEventListener("pointerup", handlePointerUp);
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
    cursorTooltipTimerRef.current = window.setTimeout(() => {
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
        document.addEventListener("pointerup", handlePointerUp, { once: true });
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
        "flex h-9 w-9 items-center justify-center rounded-[10px] border text-white/[0.96] transition-colors duration-150",
        isActive
          ? "border-white/[0.12] bg-white/[0.1] text-white"
          : "border-transparent hover:border-white/[0.08] hover:bg-white/[0.06] hover:text-white",
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
        {isCursorTooltipOpen && cursorTooltipPosition && typeof document !== "undefined"
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
              document.body,
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
    <div className="workspace-shell flex h-full flex-col bg-[#171717] text-white">
      <div className="flex items-center justify-between gap-3 pb-3 pl-2 pr-2 pt-3">
        {onLogoClick ? (
          <button
            type="button"
            onClick={onLogoClick}
            aria-label={`${BRAND_NAME} home`}
            className="grid h-9 w-9 place-items-center rounded-[10px] text-left transition hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/20"
          >
            <img src={logoMark} alt="OverDrafter logo" className="h-6 w-6 object-contain" />
          </button>
        ) : (
          <div className="grid h-9 w-9 place-items-center">
            <img src={logoMark} alt="OverDrafter logo" className="h-6 w-6 object-contain" />
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

      <div className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-3">{sidebarContent}</div>

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
      className="workspace-shell group flex h-full cursor-e-resize flex-col items-center gap-3 bg-[#171717] px-2 py-3 text-white"
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

export function ClientWorkspaceShell({
  topRightContent,
  sidebarContent,
  sidebarFooter,
  sidebarRailActions,
  onLogoClick,
  children,
}: ClientWorkspaceShellProps) {
  const [desktopSidebarCollapsed, setDesktopSidebarCollapsed] = useState(() => readDesktopSidebarCollapsed());
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const BrandLabelTag = onLogoClick ? "button" : "div";

  useEffect(() => {
    try {
      window.localStorage.setItem(
        DESKTOP_SIDEBAR_COLLAPSED_STORAGE_KEY,
        desktopSidebarCollapsed ? "1" : "0",
      );
    } catch {
      // Ignore storage failures in private browsing and restricted contexts.
    }
  }, [desktopSidebarCollapsed]);

  return (
    <TooltipProvider delayDuration={SIDEBAR_TOOLTIP_DELAY_MS}>
      <div className="workspace-shell min-h-screen bg-[#212121] text-white">
        <div className="flex min-h-screen">
          <aside
            className={cn(
              "sticky top-0 hidden shrink-0 self-start overflow-visible border-r border-white/[0.08] shadow-[1px_0_0_0_rgba(255,255,255,0.02)] transition-[width] duration-200 ease-out md:block",
            )}
            style={{
              width: desktopSidebarCollapsed ? DESKTOP_SIDEBAR_COLLAPSED_WIDTH : DESKTOP_SIDEBAR_EXPANDED_WIDTH,
            }}
          >
            <div className="h-screen">
              <div className={cn("h-full", desktopSidebarCollapsed && "hidden")}>
                <SidebarScaffold
                  sidebarContent={sidebarContent}
                  sidebarFooter={sidebarFooter}
                  onCollapse={() => setDesktopSidebarCollapsed(true)}
                  onLogoClick={onLogoClick}
                />
              </div>
              <div className={cn("h-full", desktopSidebarCollapsed ? "block" : "hidden")}>
                <CollapsedSidebarRail
                  sidebarRailActions={sidebarRailActions}
                  onOpen={() => setDesktopSidebarCollapsed(false)}
                />
              </div>
            </div>
          </aside>

          <div className="relative flex min-h-screen flex-1 flex-col">
            {desktopSidebarCollapsed ? (
              <button
                type="button"
                aria-label="Open sidebar"
                className="absolute inset-y-0 left-0 z-10 hidden w-5 cursor-e-resize bg-transparent md:block"
                onClick={() => setDesktopSidebarCollapsed(false)}
              />
            ) : null}
            <header className="flex items-center justify-between gap-3 px-4 py-3 md:px-6">
              <Sheet open={mobileSidebarOpen} onOpenChange={setMobileSidebarOpen}>
                <SheetTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="rounded-[10px] text-white/[0.96] hover:bg-white/[0.06] hover:text-white md:hidden"
                  >
                    <PanelLeftOpen className="h-5 w-5" />
                    <span className="sr-only">Open sidebar</span>
                  </Button>
                </SheetTrigger>
                <SheetContent
                  side="left"
                  className="workspace-shell w-[260px] border-r border-white/[0.08] bg-[#171717] p-0 text-white sm:max-w-[260px] [&>button]:hidden"
                >
                  <SidebarScaffold
                    sidebarContent={sidebarContent}
                    sidebarFooter={sidebarFooter}
                    onCollapse={() => setMobileSidebarOpen(false)}
                    onLogoClick={onLogoClick}
                  />
                </SheetContent>
              </Sheet>

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
                      "transition hover:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/20",
                  )}
                >
                  <span className="block truncate text-[15px] font-medium tracking-[-0.01em] text-white/[0.94]">
                    {BRAND_NAME}
                  </span>
                </BrandLabelTag>
              </div>

              <div className="ml-auto flex items-center gap-2">{topRightContent}</div>
            </header>

            <main className="flex flex-1 flex-col">{children}</main>
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
}
