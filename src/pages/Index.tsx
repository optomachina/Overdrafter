import { useQuery } from "@tanstack/react-query";
import ClientHome from "@/pages/ClientHome";
import InternalHome from "@/pages/InternalHome";
import { AuthBootstrapScreen } from "@/components/auth/AuthBootstrapScreen";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { fetchCommercialAdminAccess } from "@/features/quotes/api/commercial-admin-access-api";
import { useAppSession } from "@/hooks/use-app-session";
import { Navigate, useLocation } from "react-router-dom";

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

  return <ClientHome />;
}

const Index = () => {
  const { user, activeMembership, isAuthInitializing } = useAppSession();
  const { search, hash } = useLocation();

  if (isAuthInitializing && !user) {
    return <AuthBootstrapScreen message="Restoring your workspace." />;
  }

  if (activeMembership?.role === "internal_admin" || activeMembership?.role === "internal_estimator") {
    return <InternalHome />;
  }

  if (activeMembership?.role === "client") {
    return <Navigate to={{ pathname: "/parts", search, hash }} replace />;
  }

  if (user && !activeMembership && !isAuthInitializing) {
    return <CapabilityLanding />;
  }

  return <ClientHome />;
};

export default Index;
