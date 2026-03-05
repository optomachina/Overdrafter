import ClientHome from "@/pages/ClientHome";
import InternalHome from "@/pages/InternalHome";
import { useAppSession } from "@/hooks/use-app-session";

const Index = () => {
  const { activeMembership } = useAppSession();

  if (activeMembership?.role === "internal_admin" || activeMembership?.role === "internal_estimator") {
    return <InternalHome />;
  }

  return <ClientHome />;
};

export default Index;
