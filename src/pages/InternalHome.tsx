import { useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LayoutDashboard, Loader2, PlusSquare, UploadCloud } from "lucide-react";
import { toast } from "sonner";
import { ClientWorkspaceShell } from "@/components/workspace/ClientWorkspaceShell";
import { WorkspaceAccountMenu } from "@/components/chat/WorkspaceAccountMenu";
import { EmailVerificationPrompt } from "@/components/EmailVerificationPrompt";
import { InternalDashboardSidebar } from "@/components/internal/InternalDashboardSidebar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useWorkspaceNotifications } from "@/features/notifications/use-workspace-notifications";
import {
  resendSignupConfirmation,
  updateOrganizationMembershipRole,
} from "@/features/quotes/api/session-access";
import {
  fetchJobsByOrganization,
  fetchPublishedPackagesByOrganization,
} from "@/features/quotes/api/workspace-access";
import { fetchOrganizationMemberships } from "@/features/quotes/api/organizations-api";
import { isProjectCollaborationSchemaUnavailable } from "@/features/quotes/api/shared/schema-runtime";
import { useClientWorkspaceData } from "@/features/quotes/use-client-workspace-data";
import { formatStatusLabel, getJobSummaryMetrics } from "@/features/quotes/utils";
import { useAppSession } from "@/hooks/use-app-session";
import { supabase } from "@/integrations/supabase/client";
import type { AppRole } from "@/integrations/supabase/types";
import { isEmailConfirmationRequired } from "@/lib/auth-status";

const membershipRoleOptions: AppRole[] = ["client", "internal_estimator", "internal_admin"];

const InternalHome = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const { user, activeMembership, isVerifiedAuth, signOut } = useAppSession();
  const projectCollaborationUnavailable = isProjectCollaborationSchemaUnavailable();
  const { accessibleJobsQuery, archivedProjectsQuery, archivedJobsQuery } = useClientWorkspaceData({
    enabled: Boolean(user),
    userId: user?.id,
    projectCollaborationUnavailable,
  });
  const notificationCenter = useWorkspaceNotifications({
    jobIds: (accessibleJobsQuery.data ?? []).map((job) => job.id),
    role: activeMembership?.role,
    userId: user?.id,
  });
  const jobsQuery = useQuery({
    queryKey: ["jobs", activeMembership?.organizationId],
    queryFn: () => fetchJobsByOrganization(activeMembership!.organizationId),
    enabled: Boolean(activeMembership?.organizationId),
  });
  const packagesQuery = useQuery({
    queryKey: ["packages", activeMembership?.organizationId],
    queryFn: () => fetchPublishedPackagesByOrganization(activeMembership!.organizationId),
    enabled: Boolean(activeMembership?.organizationId),
  });
  const organizationMembershipsQuery = useQuery({
    queryKey: ["organization-memberships", activeMembership?.organizationId],
    queryFn: () => fetchOrganizationMemberships(activeMembership!.organizationId),
    enabled: activeMembership?.role === "internal_admin",
  });
  const updateMembershipRoleMutation = useMutation({
    mutationFn: (input: { membershipId: string; role: AppRole }) =>
      updateOrganizationMembershipRole(input),
    onSuccess: async () => {
      toast.success("Access updated.");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["organization-memberships"] }),
        queryClient.invalidateQueries({ queryKey: ["app-session"] }),
      ]);
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to update access.");
    },
  });

  const [isRefreshingVerification, setIsRefreshingVerification] = useState(false);
  const [isResendingVerification, setIsResendingVerification] = useState(false);
  const metrics = getJobSummaryMetrics(jobsQuery.data ?? []);
  const sidebarActiveItem =
    location.pathname === "/jobs/new" ? "new-job" : location.pathname === "/" ? "dashboard" : null;

  const handleRefreshVerification = async () => {
    setIsRefreshingVerification(true);

    try {
      const { data, error } = await supabase.auth.getUser();

      if (error) {
        throw error;
      }

      if (!data.user) {
        throw new Error("Open the confirmation link from your email first.");
      }

      if (isEmailConfirmationRequired(data.user)) {
        throw new Error("Email confirmation has not completed yet.");
      }

      await queryClient.invalidateQueries({ queryKey: ["app-session"] });
      toast.success("Email verified.");
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "Unable to refresh verification status.");
    } finally {
      setIsRefreshingVerification(false);
    }
  };

  const handleResendVerification = async () => {
    if (!user?.email) {
      toast.error("No email is available for this account.");
      return;
    }

    setIsResendingVerification(true);

    try {
      await resendSignupConfirmation(user.email);
      toast.success(`Confirmation email resent to ${user.email}.`);
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "Unable to resend confirmation email.");
    } finally {
      setIsResendingVerification(false);
    }
  };

  return (
    <ClientWorkspaceShell
      onLogoClick={() => navigate("/")}
      sidebarRailActions={[
        {
          label: "Dashboard",
          icon: LayoutDashboard,
          onClick: () => navigate("/"),
          isActive: sidebarActiveItem === "dashboard",
        },
        {
          label: "New Job",
          icon: PlusSquare,
          onClick: () => navigate("/jobs/new"),
          isActive: sidebarActiveItem === "new-job",
        },
      ]}
      sidebarContent={
        <InternalDashboardSidebar
          activeItem={sidebarActiveItem}
          role={activeMembership?.role}
          onNavigateDashboard={() => navigate("/")}
          onNavigateNewJob={() => navigate("/jobs/new")}
        />
      }
      sidebarFooter={
        user ? (
          <WorkspaceAccountMenu
            user={user}
            activeMembership={activeMembership}
            notificationCenter={notificationCenter}
            onSignOut={signOut}
            onSignedOut={() => navigate("/", { replace: true })}
            archivedProjects={archivedProjectsQuery.data}
            archivedJobs={archivedJobsQuery.data}
            isArchiveLoading={archivedProjectsQuery.isLoading || archivedJobsQuery.isLoading}
          />
        ) : null
      }
    >
      <div className="mx-auto flex w-full max-w-[1600px] flex-1 flex-col px-4 pb-8 pt-4 md:px-6 md:pb-10 md:pt-6">
        <div className="flex flex-col gap-4 pb-8 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h1 className="text-[2rem] font-medium tracking-[-0.02em] text-white md:text-[2.35rem]">
              Operations Dashboard
            </h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-white/55">
              Review extracted specs, launch vendor quote runs, and publish curated options with
              versioned pricing.
            </p>
          </div>

          <Button asChild className="rounded-full self-start">
            <Link to="/jobs/new">
              <UploadCloud className="mr-2 h-4 w-4" />
              Create Job
            </Link>
          </Button>
        </div>

        {!isVerifiedAuth && user?.email ? (
          <section className="mb-8">
            <EmailVerificationPrompt
              email={user.email}
              isRefreshing={isRefreshingVerification}
              isResending={isResendingVerification}
              onRefreshSession={() => {
                void handleRefreshVerification();
              }}
              onResend={() => {
                void handleResendVerification();
              }}
              onChangeEmail={() => {
                void signOut();
              }}
            />
          </section>
        ) : null}

        <section className="grid gap-4 lg:grid-cols-4">
          <Card className="border-white/10 bg-white/5">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium text-white/70">Total jobs</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-3xl font-semibold">{metrics.totalJobs}</p>
            </CardContent>
          </Card>
          <Card className="border-white/10 bg-white/5">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium text-white/70">In review</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-3xl font-semibold">{metrics.needsReview}</p>
            </CardContent>
          </Card>
          <Card className="border-white/10 bg-white/5">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium text-white/70">Active quote runs</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-3xl font-semibold">{metrics.quoted}</p>
            </CardContent>
          </Card>
          <Card className="border-white/10 bg-white/5">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium text-white/70">Published packages</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-3xl font-semibold">{(packagesQuery.data ?? []).length}</p>
            </CardContent>
          </Card>
        </section>

        {activeMembership?.role === "internal_admin" ? (
          <section className="mt-8">
            <Card className="border-white/10 bg-black/20">
              <CardHeader>
                <CardTitle>Team Access</CardTitle>
                <p className="text-sm text-white/55">
                  Promote client users to estimator or admin after they have joined this hidden
                  workspace.
                </p>
              </CardHeader>
              <CardContent>
                {organizationMembershipsQuery.isLoading ? (
                  <div className="flex items-center justify-center rounded-3xl border border-dashed border-white/10 bg-white/5 p-8">
                    <Loader2 className="h-5 w-5 animate-spin text-primary" />
                  </div>
                ) : organizationMembershipsQuery.isError ? (
                  <div className="rounded-3xl border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
                    {organizationMembershipsQuery.error instanceof Error
                      ? organizationMembershipsQuery.error.message
                      : "Failed to load team access."}
                  </div>
                ) : (organizationMembershipsQuery.data ?? []).length === 0 ? (
                  <div className="rounded-3xl border border-dashed border-white/10 bg-white/5 p-8 text-center">
                    <p className="font-medium">No members found</p>
                    <p className="mt-2 text-sm text-white/50">
                      Members appear here after they sign in and get attached to this account.
                    </p>
                  </div>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow className="border-white/10 hover:bg-transparent">
                        <TableHead className="text-white/55">Member</TableHead>
                        <TableHead className="text-white/55">Current role</TableHead>
                        <TableHead className="text-white/55">Created</TableHead>
                        <TableHead className="text-right text-white/55">Access level</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {(organizationMembershipsQuery.data ?? []).map((member) => {
                        const isUpdatingMember =
                          updateMembershipRoleMutation.isPending &&
                          updateMembershipRoleMutation.variables?.membershipId === member.id;

                        return (
                          <TableRow key={member.id} className="border-white/10 hover:bg-white/5">
                            <TableCell>
                              <div>
                                <p className="font-medium">{member.email}</p>
                                <p className="text-xs text-white/45">
                                  {member.userId === user?.id ? "You" : "Team member"}
                                </p>
                              </div>
                            </TableCell>
                            <TableCell>
                              <Badge
                                variant="secondary"
                                className="border border-white/10 bg-white/5 text-white/75"
                              >
                                {formatStatusLabel(member.role)}
                              </Badge>
                            </TableCell>
                            <TableCell className="text-sm text-white/55">
                              {new Date(member.createdAt).toLocaleDateString()}
                            </TableCell>
                            <TableCell className="text-right">
                              <div className="ml-auto flex w-full max-w-[220px] items-center justify-end gap-3">
                                {isUpdatingMember ? (
                                  <Loader2 className="h-4 w-4 animate-spin text-primary" />
                                ) : null}
                                <Select
                                  value={member.role}
                                  onValueChange={(value) =>
                                    updateMembershipRoleMutation.mutate({
                                      membershipId: member.id,
                                      role: value as AppRole,
                                    })
                                  }
                                  disabled={!isVerifiedAuth || updateMembershipRoleMutation.isPending}
                                >
                                  <SelectTrigger className="border-white/10 bg-white/5 text-white">
                                    <SelectValue placeholder="Select role" />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {membershipRoleOptions.map((role) => (
                                      <SelectItem key={role} value={role}>
                                        {formatStatusLabel(role)}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              </div>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </section>
        ) : null}
      </div>
    </ClientWorkspaceShell>
  );
};

export default InternalHome;
