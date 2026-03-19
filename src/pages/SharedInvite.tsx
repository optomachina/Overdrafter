import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { ClientWorkspaceShell } from "@/components/workspace/ClientWorkspaceShell";
import { GuestSidebarCta } from "@/components/chat/GuestSidebarCta";
import { SignInDialog } from "@/components/SignInDialog";
import { Button } from "@/components/ui/button";
import { useAppSession } from "@/hooks/use-app-session";
import { acceptProjectInvite } from "@/features/quotes/api";

const SharedInvite = () => {
  const { inviteToken = "" } = useParams();
  const navigate = useNavigate();
  const { user, isVerifiedAuth } = useAppSession();
  const [authOpen, setAuthOpen] = useState(false);
  const acceptInviteMutation = useMutation({
    mutationFn: () => acceptProjectInvite(inviteToken),
    onSuccess: (projectId) => {
      toast.success("Project access unlocked.");
      navigate(`/projects/${projectId}`, { replace: true });
    },
    onError: (error: Error) => {
      toast.error(error.message || "This invite could not be accepted.");
    },
  });

  useEffect(() => {
    if (!user) {
      setAuthOpen(true);
      return;
    }

    if (isVerifiedAuth && inviteToken && acceptInviteMutation.status === "idle") {
      acceptInviteMutation.mutate();
    }
  }, [acceptInviteMutation, inviteToken, isVerifiedAuth, user]);

  return (
    <>
      <ClientWorkspaceShell
        topRightContent={
          !user ? (
            <>
              <Button
                type="button"
                className="h-10 rounded-full bg-white px-4 text-sm font-medium text-black hover:bg-white/90"
                onClick={() => setAuthOpen(true)}
              >
                Log in
              </Button>
              <Button
                type="button"
                variant="outline"
                className="h-10 rounded-full border-white/10 bg-transparent px-4 text-sm text-white hover:bg-white/6"
                onClick={() => setAuthOpen(true)}
              >
                Sign up for free
              </Button>
            </>
          ) : null
        }
        sidebarContent={<div className="px-3 text-sm text-white/55">Shared project invite</div>}
        sidebarFooter={!user ? <GuestSidebarCta onLogIn={() => setAuthOpen(true)} /> : null}
      >
        <div className="mx-auto flex w-full max-w-[640px] flex-1 flex-col items-center justify-center px-6 pb-16">
          <div className="w-full rounded-[28px] border border-white/8 bg-[#2a2a2a] p-8 text-center shadow-[0_8px_40px_rgba(0,0,0,0.2)]">
            <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-full bg-white/8">
              <Loader2 className="h-5 w-5 animate-spin text-white/80" />
            </div>
            <h1 className="text-3xl font-semibold tracking-tight text-white">Open shared project</h1>
            <p className="mt-3 text-sm leading-6 text-white/55">
              {user
                ? isVerifiedAuth
                  ? "Checking the invite and redirecting you into the project."
                  : "Verify your email or sign in with a social provider before accepting the invite."
                : "Sign in with the invited email address to join this shared project."}
            </p>
            {acceptInviteMutation.isError ? (
              <p className="mt-4 text-sm text-destructive">
                {acceptInviteMutation.error instanceof Error
                  ? acceptInviteMutation.error.message
                  : "This invite could not be accepted."}
              </p>
            ) : null}
          </div>
        </div>
      </ClientWorkspaceShell>

      <SignInDialog
        open={authOpen}
        onOpenChange={setAuthOpen}
        initialMode="sign-in"
        redirectPath={`/shared/${inviteToken}`}
      />
    </>
  );
};

export default SharedInvite;
