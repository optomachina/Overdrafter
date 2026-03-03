import { Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { AuthPanel } from "@/components/auth/AuthPanel";
import { GuestAppShell } from "@/components/auth/GuestAppShell";

const SignIn = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const recoveryModeRequested = searchParams.get("mode") === "recovery";

  if (!recoveryModeRequested) {
    return <Navigate to="/?auth=signin" replace />;
  }

  return (
    <GuestAppShell
      authOpen
      heading="Reset your password"
      subtitle="Finish the recovery step and return directly to the app."
      reservePanelSpace
      onOpenAuth={(mode) => {
        navigate(mode === "signup" ? "/?auth=signup" : "/?auth=signin", { replace: true });
      }}
      panel={<AuthPanel initialMode="update-password" />}
    />
  );
};

export default SignIn;
