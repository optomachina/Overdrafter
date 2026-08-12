import { useQuery } from "@tanstack/react-query";
import ClientHome from "@/pages/ClientHome";
import InternalHome from "@/pages/InternalHome";
import { AuthBootstrapScreen } from "@/components/auth/AuthBootstrapScreen";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { fetchCommercialAdminAccess } from "@/features/quotes/api/commercial-admin-access-api";
import { deriveRootAccessState } from "@/features/auth/root-access-state";
import { useClientHomeController } from "@/features/quotes/use-client-home-controller";
import { useAppSession } from "@/hooks/use-app-session";
import { Navigate, useLocation } from "react-router-dom";

function WorkspaceAccessMessage({
  title,
  description,
  action,
}: Readonly<{
  title: string;
  description: string;
  action?: React.ReactNode;
}>) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6">
      <Card className="w-full max-w-lg border-border bg-muted">
        <CardHeader>
          <CardTitle>{title}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground" role="status">
            {description}
          </p>
          {action}
        </CardContent>
      </Card>
    </main>
  );
}

function ClientWorkspaceProvisioning() {
  const { workspaceReadiness, handleRefreshVerification } = useClientHomeController();
  const { search, hash } = useLocation();

  switch (workspaceReadiness.status) {
    case "ready":
      return <Navigate to={{ pathname: "/parts", search, hash }} replace />;
    case "unverified":
      return (
        <WorkspaceAccessMessage
          title="Verify your email to continue"
          description="Confirm your email address, then check again to finish preparing your workspace."
          action={
            <Button type="button" onClick={() => void handleRefreshVerification()}>
              Check verification status
            </Button>
          }
        />
      );
    case "provisioning_failed":
      return (
        <WorkspaceAccessMessage
          title="Workspace setup needs attention"
          description={workspaceReadiness.error}
          action={
            <Button type="button" onClick={() => window.location.reload()}>
              Refresh workspace
            </Button>
          }
        />
      );
    case "anonymous":
      return <ClientHome />;
    case "loading":
    case "provisioning":
      return <AuthBootstrapScreen message="Preparing your workspace." />;
  }
}

function CapabilityLanding() {
  const accessQuery = useQuery({
    queryKey: ["commercial-admin-access"],
    queryFn: fetchCommercialAdminAccess,
  });

  if (accessQuery.isLoading) {
    return <AuthBootstrapScreen message="Checking commercial admin access." />;
  }

  if (accessQuery.isError) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background p-6">
        <Card className="w-full max-w-lg border-destructive/30 bg-muted">
          <CardHeader>
            <CardTitle>Commercial access could not be checked</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground" role="alert">
              We could not safely determine which workspace to open. Retry the
              access check.
            </p>
            <Button
              type="button"
              onClick={() => void accessQuery.refetch()}
              disabled={accessQuery.isFetching}
            >
              {accessQuery.isFetching ? "Retrying…" : "Retry"}
            </Button>
          </CardContent>
        </Card>
      </main>
    );
  }

  if (accessQuery.data?.hasCapability) {
    return <Navigate to="/internal/commercial" replace />;
  }

  return <ClientWorkspaceProvisioning />;
}

const Index = () => {
  const { user, activeMembership, isAuthInitializing } = useAppSession();
  const { search, hash } = useLocation();
  const accessState = deriveRootAccessState({
    user,
    activeMembership,
    isAuthInitializing,
  });

  switch (accessState.status) {
    case "restoring":
      return <AuthBootstrapScreen message="Restoring your workspace." />;
    case "internal":
      return <InternalHome />;
    case "client":
      return <Navigate to={{ pathname: "/parts", search, hash }} replace />;
    case "capability_check":
      return <CapabilityLanding />;
    case "anonymous":
      return <ClientHome />;
  }
};

export default Index;
