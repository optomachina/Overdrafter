import { useQuery } from "@tanstack/react-query";
import ClientHome from "@/pages/ClientHome";
import InternalHome from "@/pages/InternalHome";
import { AuthBootstrapScreen } from "@/components/auth/AuthBootstrapScreen";
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
