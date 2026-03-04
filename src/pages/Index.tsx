import ClientHome from "@/pages/ClientHome";
import InternalHome from "@/pages/InternalHome";
import { useAppSession } from "@/hooks/use-app-session";

const Index = () => {
  const { activeMembership, isLoading } = useAppSession();

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#212121] text-white">
        <div className="text-sm text-white/60">Loading workspace…</div>
      </div>
    );
  }

  if (activeMembership?.role === "internal_admin" || activeMembership?.role === "internal_estimator") {
    return <InternalHome />;
  }

  return <ClientHome />;
};

export default Index;
