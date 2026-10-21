import type { AppMembership } from "@/features/quotes/types";
import type { WorkspaceAccessScope } from "@/features/quotes/workspace-navigation";
import { useWorkspaceNotifications } from "./use-workspace-notifications";

type ClientNotificationContext = {
  workspaceAccessScope: WorkspaceAccessScope;
  isPlatformAdmin: boolean;
  activeMembership?: Pick<AppMembership, "role"> | null;
  user?: { id: string } | null;
};

export function useClientWorkspaceNotifications(controller: ClientNotificationContext, jobIds: string[]) {
  return useWorkspaceNotifications({
    accessScope: controller.workspaceAccessScope,
    isPlatformAdmin: controller.isPlatformAdmin,
    jobIds,
    role: controller.activeMembership?.role,
    userId: controller.user?.id,
  });
}
