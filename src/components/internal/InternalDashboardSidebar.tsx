import { LayoutDashboard, PlusSquare, ShieldAlert, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatStatusLabel } from "@/features/quotes/utils";
import type { AppRole } from "@/integrations/supabase/types";
import { cn } from "@/lib/utils";

type InternalDashboardSidebarProps = {
  activeItem: "dashboard" | "new-job" | "admin" | null;
  role?: AppRole | null;
  isPlatformAdmin?: boolean;
  onNavigateDashboard: () => void;
  onNavigateNewJob: () => void;
  onNavigateAdmin?: () => void;
};

type SidebarActionButtonProps = {
  active: boolean;
  icon: typeof LayoutDashboard;
  label: string;
  onClick: () => void;
};

function SidebarActionButton({
  active,
  icon: Icon,
  label,
  onClick,
}: SidebarActionButtonProps) {
  return (
    <Button
      type="button"
      variant="ghost"
      className={cn(
        "w-full justify-start rounded-[10px] pl-1 pr-3 text-foreground hover:bg-accent hover:text-foreground",
        active && "bg-accent text-foreground",
      )}
      onClick={onClick}
    >
      <span className="flex w-5 shrink-0 items-center justify-center text-foreground">
        <Icon aria-hidden="true" className="h-4 w-4" />
      </span>
      {label}
    </Button>
  );
}

export function InternalDashboardSidebar({
  activeItem,
  role,
  isPlatformAdmin = false,
  onNavigateDashboard,
  onNavigateNewJob,
  onNavigateAdmin,
}: InternalDashboardSidebarProps) {
  return (
    <div className="space-y-5">
      <div className="rounded-[20px] border border-border bg-accent px-4 py-4">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-[14px] bg-accent text-foreground">
            <ShieldCheck className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
              Internal workspace
            </p>
            <p className="truncate text-sm text-foreground/80">
              {role ? formatStatusLabel(role) : "Operations"}
            </p>
          </div>
        </div>
      </div>

      <div className="space-y-1">
        <SidebarActionButton
          active={activeItem === "dashboard"}
          icon={LayoutDashboard}
          label="Dashboard"
          onClick={onNavigateDashboard}
        />
        <SidebarActionButton
          active={activeItem === "new-job"}
          icon={PlusSquare}
          label="New Job"
          onClick={onNavigateNewJob}
        />
        {isPlatformAdmin && onNavigateAdmin ? (
          <SidebarActionButton
            active={activeItem === "admin"}
            icon={ShieldAlert}
            label="God Mode"
            onClick={onNavigateAdmin}
          />
        ) : null}
      </div>
    </div>
  );
}
