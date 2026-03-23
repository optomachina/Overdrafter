import { useState, type ReactNode } from "react";
import { ArrowUp, ChevronDown, CircleHelp, Loader2, Menu, Plus, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { buildAuthRedirectUrl } from "@/lib/auth-redirect";
import { cn } from "@/lib/utils";

type GuestAppShellProps = {
  authOpen?: boolean;
  heading?: string;
  panel?: ReactNode;
  reservePanelSpace?: boolean;
  subtitle?: string;
  onOpenAuth: (mode: "signin" | "signup") => void;
};

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Authentication failed.";
}

export function GuestAppShell({
  authOpen = false,
  heading = "What can I help with?",
  panel,
  reservePanelSpace = false,
  subtitle = "",
  onOpenAuth,
}: GuestAppShellProps) {
  const [isGooglePending, setIsGooglePending] = useState(false);

  const openSignIn = () => onOpenAuth("signin");
  const openSignUp = () => onOpenAuth("signup");

  const handleGoogleContinue = async () => {
    setIsGooglePending(true);

    try {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: {
          redirectTo: buildAuthRedirectUrl("/"),
        },
      });

      if (error) {
        throw error;
      }
    } catch (error: unknown) {
      setIsGooglePending(false);
      toast.error(getErrorMessage(error));
    }
  };

  return (
    <div className="min-h-svh overflow-hidden bg-[radial-gradient(circle_at_top,hsl(var(--primary)/0.11),transparent_24%),linear-gradient(180deg,#1f2024_0%,#1b1c20_48%,#17181c_100%)] text-foreground">
      <div className="relative mx-auto flex min-h-svh w-full max-w-[980px] flex-col">
        <header className="relative z-10 flex items-center justify-between px-4 pt-8 sm:px-6 sm:pt-6">
          <div className="flex items-center gap-3 text-white/90">
            <button
              type="button"
              className="grid h-10 w-10 place-items-center rounded-full text-white/85 transition-colors hover:bg-white/10"
              onClick={openSignIn}
              aria-label="Open menu"
            >
              <Menu className="h-6 w-6" />
            </button>
            <button
              type="button"
              className="flex items-center gap-2 text-[26px] font-medium tracking-tight"
              onClick={openSignIn}
            >
              <span className="text-3xl leading-none">OverDrafter</span>
              <ChevronDown className="h-5 w-5 text-white/60" />
            </button>
          </div>

          <div className="flex items-center gap-2">
            <Button
              className="h-12 rounded-full bg-white px-6 text-lg font-semibold text-black hover:bg-white/90"
              onClick={openSignIn}
            >
              Log in
            </Button>
            <button
              type="button"
              className="grid h-10 w-10 place-items-center rounded-full border border-white/30 text-white/85 transition-colors hover:bg-white/10"
              onClick={openSignUp}
              aria-label="Help"
            >
              <CircleHelp className="h-6 w-6" />
            </button>
          </div>
        </header>

        <main className="relative flex flex-1 flex-col px-4 pb-6 pt-6 sm:px-6">
          <div
            className={cn(
              "mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center",
              panel && reservePanelSpace && "xl:max-w-5xl xl:pr-[430px]",
            )}
          >
            <div className="mx-auto w-full max-w-2xl text-center">
              <h1 className="text-5xl font-medium tracking-tight text-white sm:text-6xl">{heading}</h1>
              {subtitle ? <p className="mt-5 text-lg text-white/65">{subtitle}</p> : null}
            </div>
          </div>

          <div className="mx-auto w-full max-w-4xl pb-4">
            <button
              type="button"
              className={cn(
                "group flex w-full items-center gap-3 rounded-surface-lg border border-white/10 bg-white/[0.09] px-4 py-3 text-left shadow-[0_20px_40px_rgba(0,0,0,0.2)] transition-[border-color,background-color] hover:border-white/20 hover:bg-white/[0.12]",
                authOpen && "border-primary/50",
              )}
              onClick={openSignIn}
            >
              <span className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-white/[0.13] text-white/90">
                <Plus className="h-7 w-7" />
              </span>
              <span className="min-w-0 flex-1 text-4xl text-white/58 sm:text-2xl">Ask anything</span>
              <span className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-white/[0.13] text-white/65 transition-colors group-hover:text-white">
                <ArrowUp className="h-7 w-7" />
              </span>
            </button>

            <p className="mt-5 px-1 text-center text-sm leading-6 text-white/66">
              By messaging OverDrafter, you agree to our <span className="underline">Terms</span> and have read our{' '}
              <span className="underline">Privacy Policy</span>.
            </p>
          </div>

          {panel ? (
            <>
              <div className="hidden xl:block">
                <div className="absolute right-6 top-6 w-[380px]">{panel}</div>
              </div>
              <div className="mx-auto mt-8 w-full max-w-[380px] xl:hidden">{panel}</div>
            </>
          ) : null}
        </main>

        {!authOpen ? (
          <div className="fixed inset-x-0 bottom-0 z-20 px-3 pb-3 sm:left-1/2 sm:max-w-[620px] sm:-translate-x-1/2 sm:px-0">
            <div className="rounded-surface-lg border border-white/10 bg-ws-deep/96 p-4 shadow-[0_-8px_40px_rgba(0,0,0,0.45)] backdrop-blur">
              <div className="flex items-center gap-3 text-white/82">
                <GoogleIcon className="h-10 w-10" />
                <p className="flex-1 text-lg font-medium leading-tight">Sign in to OverDrafter with Google</p>
                <button
                  type="button"
                  className="grid h-8 w-8 place-items-center rounded-full text-white/55 transition-colors hover:bg-white/10 hover:text-white"
                  onClick={openSignIn}
                  aria-label="Dismiss"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>

              <Button
                type="button"
                className="mt-4 h-11 w-full rounded-full bg-primary text-lg font-medium text-primary-foreground hover:bg-primary/90"
                disabled={isGooglePending}
                onClick={() => {
                  void handleGoogleContinue();
                }}
              >
                {isGooglePending ? <Loader2 className="h-5 w-5 animate-spin" /> : "Continue"}
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function GoogleIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className}>
      <path
        fill="#EA4335"
        d="M12 10.2v4h5.66c-.24 1.3-1.5 3.8-5.66 3.8-3.4 0-6.18-2.82-6.18-6.3s2.78-6.3 6.18-6.3c1.94 0 3.24.83 3.98 1.54l2.72-2.63C17.02 2.72 14.72 1.8 12 1.8 6.48 1.8 2 6.34 2 11.9S6.48 22 12 22c6.92 0 9.2-4.9 9.2-7.44 0-.5-.04-.9-.12-1.3H12z"
      />
      <path fill="#34A853" d="M3.15 7.25l3.28 2.4C7.35 7.7 9.5 6.1 12 6.1c1.94 0 3.24.83 3.98 1.54l2.72-2.63C17.02 2.72 14.72 1.8 12 1.8c-3.88 0-7.2 2.26-8.85 5.45z" />
      <path fill="#4A90E2" d="M12 22c2.62 0 4.84-.86 6.46-2.34l-2.98-2.47c-.8.56-1.82.96-3.48.96-4.15 0-5.42-2.5-5.66-3.8l-3.26 2.5C4.7 19.75 8.06 22 12 22z" />
      <path fill="#FBBC05" d="M6.34 14.35A6.44 6.44 0 0 1 6 11.9c0-.85.13-1.67.34-2.45l-3.28-2.4A10.1 10.1 0 0 0 2 11.9c0 1.7.4 3.3 1.06 4.75l3.28-2.3z" />
    </svg>
  );
}
