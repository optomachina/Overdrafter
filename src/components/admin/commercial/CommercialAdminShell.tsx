import type { ReactNode } from "react";
import type { User } from "@supabase/supabase-js";
import {
  Building2,
  LayoutDashboard,
  ShieldAlert,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import { WorkspaceAccountMenu } from "@/components/chat/WorkspaceAccountMenu";
import { InternalDashboardSidebar } from "@/components/internal/InternalDashboardSidebar";
import { ClientWorkspaceShell } from "@/components/workspace/ClientWorkspaceShell";
import type { AppMembership } from "@/features/quotes/types";

type CommercialAdminShellProps = {
  user: User;
  activeMembership?: AppMembership | null;
  isPlatformAdmin: boolean;
  onSignOut: () => Promise<void> | void;
  children: ReactNode;
};

export function CommercialAdminShell({
  user,
  activeMembership,
  isPlatformAdmin,
  onSignOut,
  children,
}: Readonly<CommercialAdminShellProps>) {
  const navigate = useNavigate();

  return (
    <ClientWorkspaceShell
      onLogoClick={() => navigate("/")}
      sidebarRailActions={[
        {
          label: "Dashboard",
          icon: LayoutDashboard,
          onClick: () => navigate("/"),
        },
        {
          label: "Commercial accounts",
          icon: Building2,
          isActive: true,
          onClick: () => navigate("/internal/commercial"),
        },
        ...(isPlatformAdmin
          ? [
              {
                label: "God Mode",
                icon: ShieldAlert,
                onClick: () => navigate("/internal/admin"),
              },
            ]
          : []),
      ]}
      sidebarContent={
        <InternalDashboardSidebar
          activeItem="commercial-accounts"
          role={activeMembership?.role}
          isPlatformAdmin={isPlatformAdmin}
          hasCommercialAdminAccess
          onNavigateDashboard={() => navigate("/")}
          onNavigateNewJob={() => navigate("/jobs/new")}
          onNavigateAdmin={() => navigate("/internal/admin")}
          onNavigateCommercial={() => navigate("/internal/commercial")}
        />
      }
      sidebarFooter={
        <WorkspaceAccountMenu
          user={user}
          activeMembership={activeMembership}
          onSignOut={onSignOut}
          onSignedOut={() => navigate("/", { replace: true })}
        />
      }
    >
      {children}
    </ClientWorkspaceShell>
  );
}
