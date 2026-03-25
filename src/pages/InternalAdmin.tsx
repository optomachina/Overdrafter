import { useQuery } from "@tanstack/react-query";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { LayoutDashboard, Loader2, PlusSquare } from "lucide-react";
import { WorkspaceAccountMenu } from "@/components/chat/WorkspaceAccountMenu";
import { AuthBootstrapScreen } from "@/components/auth/AuthBootstrapScreen";
import { InternalDashboardSidebar } from "@/components/internal/InternalDashboardSidebar";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ClientWorkspaceShell } from "@/components/workspace/ClientWorkspaceShell";
import { useWorkspaceNotifications } from "@/features/notifications/use-workspace-notifications";
import {
  fetchAdminAllJobs,
  fetchAdminAllProjects,
  fetchAdminAllUsers,
  fetchAdminOrganizations,
} from "@/features/quotes/api/workspace-access";
import { isProjectCollaborationSchemaUnavailable } from "@/features/quotes/api/shared/schema-runtime";
import { useClientWorkspaceData } from "@/features/quotes/use-client-workspace-data";
import { formatStatusLabel } from "@/features/quotes/utils";
import { useAppSession } from "@/hooks/use-app-session";
import { recordWorkspaceSessionDiagnostic } from "@/lib/workspace-session-diagnostics";

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString();
}

function LoadingState() {
  return (
    <div className="flex items-center justify-center rounded-3xl border border-dashed border-white/10 bg-white/5 p-8">
      <Loader2 className="h-5 w-5 animate-spin text-primary" />
    </div>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <div className="rounded-3xl border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
      {message}
    </div>
  );
}

function EmptyState({ title, description }: { title: string; description: string }) {
  return (
    <div className="rounded-3xl border border-dashed border-white/10 bg-white/5 p-8 text-center">
      <p className="font-medium">{title}</p>
      <p className="mt-2 text-sm text-white/50">{description}</p>
    </div>
  );
}

const badgeClassName = "border border-white/10 bg-white/5 text-white/75";

const InternalAdmin = () => {
  const navigate = useNavigate();
  const { user, activeMembership, isPlatformAdmin, signOut, isAuthInitializing } = useAppSession();
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
  const organizationsQuery = useQuery({
    queryKey: ["admin-orgs"],
    queryFn: fetchAdminOrganizations,
    enabled: isPlatformAdmin,
  });
  const usersQuery = useQuery({
    queryKey: ["admin-users"],
    queryFn: fetchAdminAllUsers,
    enabled: isPlatformAdmin,
  });
  const jobsQuery = useQuery({
    queryKey: ["admin-jobs"],
    queryFn: fetchAdminAllJobs,
    enabled: isPlatformAdmin,
  });
  const projectsQuery = useQuery({
    queryKey: ["admin-projects"],
    queryFn: fetchAdminAllProjects,
    enabled: isPlatformAdmin,
  });

  if (isAuthInitializing) {
    return <AuthBootstrapScreen message="Restoring your platform admin session." />;
  }

  if (!user) {
    recordWorkspaceSessionDiagnostic(
      "warn",
      "internal-admin.redirect.unauthenticated",
      "Redirecting to sign-in after startup auth resolution completed without a user.",
    );
    return <Navigate to="/?auth=signin" replace />;
  }

  if (!activeMembership) {
    return <Navigate to="/" replace />;
  }

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
          label: "New Job",
          icon: PlusSquare,
          onClick: () => navigate("/jobs/new"),
        },
      ]}
      sidebarContent={
        <InternalDashboardSidebar
          activeItem="admin"
          role={activeMembership.role}
          isPlatformAdmin={isPlatformAdmin}
          onNavigateDashboard={() => navigate("/")}
          onNavigateNewJob={() => navigate("/jobs/new")}
          onNavigateAdmin={() => navigate("/internal/admin")}
        />
      }
      sidebarFooter={
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
      }
    >
      <div className="mx-auto flex w-full max-w-[1600px] flex-1 flex-col px-4 pb-8 pt-4 md:px-6 md:pb-10 md:pt-6">
        <div className="pb-8">
          <h1 className="text-[2rem] font-medium tracking-[-0.02em] text-white md:text-[2.35rem]">
            Platform Admin God Mode
          </h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-white/55">
            Inspect organizations, memberships, jobs, and shared projects across the platform
            without switching accounts. Cross-organization access stays read-only.
          </p>
        </div>

        {!isPlatformAdmin ? (
          <Card className="border-white/10 bg-black/20">
            <CardHeader>
              <CardTitle>Not authorized</CardTitle>
            </CardHeader>
            <CardContent className="pt-0 text-sm text-white/60">
              This page is only available to platform admins on the private allowlist.
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-8">
            <section>
              <Card className="border-white/10 bg-black/20">
                <CardHeader>
                  <CardTitle>Organizations</CardTitle>
                  <p className="text-sm text-white/55">
                    All organizations with membership and active job counts.
                  </p>
                </CardHeader>
                <CardContent>
                  {organizationsQuery.isLoading ? (
                    <LoadingState />
                  ) : organizationsQuery.isError ? (
                    <ErrorState
                      message={
                        organizationsQuery.error instanceof Error
                          ? organizationsQuery.error.message
                          : "Failed to load organizations."
                      }
                    />
                  ) : (organizationsQuery.data ?? []).length === 0 ? (
                    <EmptyState
                      title="No organizations found"
                      description="Organizations appear here after they are created."
                    />
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow className="border-white/10 hover:bg-transparent">
                          <TableHead className="text-white/55">Name</TableHead>
                          <TableHead className="text-white/55">Slug</TableHead>
                          <TableHead className="text-white/55">Members</TableHead>
                          <TableHead className="text-white/55">Active Jobs</TableHead>
                          <TableHead className="text-white/55">Created</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {(organizationsQuery.data ?? []).map((organization) => (
                          <TableRow
                            key={organization.id}
                            className="border-white/10 hover:bg-white/5"
                          >
                            <TableCell className="font-medium">{organization.name}</TableCell>
                            <TableCell className="text-sm text-white/55">{organization.slug}</TableCell>
                            <TableCell>{organization.memberCount}</TableCell>
                            <TableCell>{organization.activeJobCount}</TableCell>
                            <TableCell className="text-sm text-white/55">
                              {formatDate(organization.createdAt)}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </CardContent>
              </Card>
            </section>

            <section>
              <Card className="border-white/10 bg-black/20">
                <CardHeader>
                  <CardTitle>Users</CardTitle>
                  <p className="text-sm text-white/55">
                    Memberships across all organizations, including role assignments.
                  </p>
                </CardHeader>
                <CardContent>
                  {usersQuery.isLoading ? (
                    <LoadingState />
                  ) : usersQuery.isError ? (
                    <ErrorState
                      message={
                        usersQuery.error instanceof Error
                          ? usersQuery.error.message
                          : "Failed to load platform memberships."
                      }
                    />
                  ) : (usersQuery.data ?? []).length === 0 ? (
                    <EmptyState
                      title="No memberships found"
                      description="Organization members appear here after joining a workspace."
                    />
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow className="border-white/10 hover:bg-transparent">
                          <TableHead className="text-white/55">Email</TableHead>
                          <TableHead className="text-white/55">Org</TableHead>
                          <TableHead className="text-white/55">Role</TableHead>
                          <TableHead className="text-white/55">Joined</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {(usersQuery.data ?? []).map((member) => (
                          <TableRow key={member.id} className="border-white/10 hover:bg-white/5">
                            <TableCell className="font-medium">{member.email}</TableCell>
                            <TableCell className="text-sm text-white/55">
                              {member.organizationName}
                            </TableCell>
                            <TableCell>
                              <Badge variant="secondary" className={badgeClassName}>
                                {formatStatusLabel(member.role)}
                              </Badge>
                            </TableCell>
                            <TableCell className="text-sm text-white/55">
                              {formatDate(member.createdAt)}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </CardContent>
              </Card>
            </section>

            <section>
              <Card className="border-white/10 bg-black/20">
                <CardHeader>
                  <CardTitle>Jobs / Parts</CardTitle>
                  <p className="text-sm text-white/55">
                    Active jobs across the platform, with direct links into internal job detail.
                  </p>
                </CardHeader>
                <CardContent>
                  {jobsQuery.isLoading ? (
                    <LoadingState />
                  ) : jobsQuery.isError ? (
                    <ErrorState
                      message={
                        jobsQuery.error instanceof Error
                          ? jobsQuery.error.message
                          : "Failed to load jobs."
                      }
                    />
                  ) : (jobsQuery.data ?? []).length === 0 ? (
                    <EmptyState
                      title="No jobs found"
                      description="Non-archived jobs appear here once organizations start uploading work."
                    />
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow className="border-white/10 hover:bg-transparent">
                          <TableHead className="text-white/55">Title</TableHead>
                          <TableHead className="text-white/55">Org</TableHead>
                          <TableHead className="text-white/55">Status</TableHead>
                          <TableHead className="text-white/55">Created</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {(jobsQuery.data ?? []).map((job) => (
                          <TableRow key={job.id} className="border-white/10 hover:bg-white/5">
                            <TableCell>
                              <div>
                                <Link
                                  to={`/internal/jobs/${job.id}`}
                                  className="font-medium text-white underline-offset-4 hover:underline"
                                >
                                  {job.title}
                                </Link>
                                <p className="text-xs text-white/45">
                                  {job.partCount} {job.partCount === 1 ? "part" : "parts"}
                                </p>
                              </div>
                            </TableCell>
                            <TableCell className="text-sm text-white/55">{job.organizationName}</TableCell>
                            <TableCell>
                              <Badge variant="secondary" className={badgeClassName}>
                                {formatStatusLabel(job.status)}
                              </Badge>
                            </TableCell>
                            <TableCell className="text-sm text-white/55">
                              {formatDate(job.createdAt)}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </CardContent>
              </Card>
            </section>

            <section>
              <Card className="border-white/10 bg-black/20">
                <CardHeader>
                  <CardTitle>Projects</CardTitle>
                  <p className="text-sm text-white/55">
                    Shared project workspaces across organizations with member and job counts.
                  </p>
                </CardHeader>
                <CardContent>
                  {projectsQuery.isLoading ? (
                    <LoadingState />
                  ) : projectsQuery.isError ? (
                    <ErrorState
                      message={
                        projectsQuery.error instanceof Error
                          ? projectsQuery.error.message
                          : "Failed to load projects."
                      }
                    />
                  ) : (projectsQuery.data ?? []).length === 0 ? (
                    <EmptyState
                      title="No projects found"
                      description="Non-archived shared projects appear here after collaboration is set up."
                    />
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow className="border-white/10 hover:bg-transparent">
                          <TableHead className="text-white/55">Name</TableHead>
                          <TableHead className="text-white/55">Org</TableHead>
                          <TableHead className="text-white/55">Owner</TableHead>
                          <TableHead className="text-white/55">Members</TableHead>
                          <TableHead className="text-white/55">Jobs</TableHead>
                          <TableHead className="text-white/55">Created</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {(projectsQuery.data ?? []).map((project) => (
                          <TableRow key={project.id} className="border-white/10 hover:bg-white/5">
                            <TableCell className="font-medium">{project.name}</TableCell>
                            <TableCell className="text-sm text-white/55">
                              {project.organizationName}
                            </TableCell>
                            <TableCell className="text-sm text-white/55">
                              {project.ownerEmail ?? "Unknown owner"}
                            </TableCell>
                            <TableCell>{project.memberCount}</TableCell>
                            <TableCell>{project.jobCount}</TableCell>
                            <TableCell className="text-sm text-white/55">
                              {formatDate(project.createdAt)}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </CardContent>
              </Card>
            </section>
          </div>
        )}
      </div>
    </ClientWorkspaceShell>
  );
};

export default InternalAdmin;
