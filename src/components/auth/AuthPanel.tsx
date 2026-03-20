import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { EmailVerificationPrompt } from "@/components/EmailVerificationPrompt";
import { SocialAuthButtons } from "@/components/SocialAuthButtons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { useAppSession } from "@/hooks/use-app-session";
import { supabase } from "@/integrations/supabase/client";
import { buildAuthRedirectUrl } from "@/lib/auth-redirect";
import { isEmailConfirmationRequired } from "@/lib/auth-status";
import { cn } from "@/lib/utils";
import {
  requestPasswordReset,
  resendSignupConfirmation,
  updateCurrentUserPassword,
} from "@/features/quotes/api/session-access";

export type AuthPanelMode =
  | "sign-in"
  | "sign-up"
  | "forgot-password"
  | "update-password"
  | "verify-email";

type AuthPanelProps = {
  className?: string;
  initialMode?: AuthPanelMode;
  onSuccess?: () => void;
  redirectPath?: string;
};

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Authentication failed.";
}

function isEmailNotConfirmedError(error: unknown) {
  return error instanceof Error && error.message.toLowerCase().includes("email not confirmed");
}

function getPanelCopy(authMode: AuthPanelMode) {
  switch (authMode) {
    case "sign-up":
      return {
        eyebrow: "Join OverDrafter",
        title: "Create your account",
        description: "Create one account and keep quoting activity in one place.",
        submitLabel: "Create account",
      };
    case "forgot-password":
      return {
        eyebrow: "Reset access",
        title: "Check your email next",
        description: "Enter your email address and we will send a recovery link.",
        submitLabel: "Send reset link",
      };
    case "update-password":
      return {
        eyebrow: "Secure your account",
        title: "Choose a new password",
        description: "Finish the recovery flow, then return directly to the app.",
        submitLabel: "Update password",
      };
    case "verify-email":
      return {
        eyebrow: "Confirm your email",
        title: "Email verification required",
        description: "Open the confirmation link from your inbox to finish setting up the account.",
        submitLabel: "Check your email",
      };
    case "sign-in":
    default:
      return {
        eyebrow: "Welcome back",
        title: "Log in to OverDrafter",
        description: "Access uploads, quote reviews, and published packages from the same account.",
        submitLabel: "Log in",
      };
  }
}

export function AuthPanel({
  className,
  initialMode = "sign-in",
  onSuccess,
  redirectPath = "/",
}: AuthPanelProps) {
  const navigate = useNavigate();
  const { user, refetch } = useAppSession();
  const [authMode, setAuthMode] = useState<AuthPanelMode>(initialMode);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [notice, setNotice] = useState<string | null>(
    initialMode === "update-password" ? "Choose a new password for your account." : null,
  );
  const [pendingVerificationEmail, setPendingVerificationEmail] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isRefreshingVerification, setIsRefreshingVerification] = useState(false);
  const [isResendingVerification, setIsResendingVerification] = useState(false);

  useEffect(() => {
    setAuthMode(initialMode);
    setNotice(initialMode === "update-password" ? "Choose a new password for your account." : null);
    setPendingVerificationEmail("");
    setPassword("");
    setConfirmPassword("");
  }, [initialMode]);

  useEffect(() => {
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY") {
        setAuthMode("update-password");
        setNotice("Choose a new password for your account.");
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  const panelCopy = getPanelCopy(authMode);
  const showEmailField = authMode !== "update-password" && authMode !== "verify-email";
  const showPasswordField = authMode !== "forgot-password" && authMode !== "verify-email";
  const showConfirmPasswordField = authMode === "update-password";
  const showSocialAuth = authMode === "sign-in" || authMode === "sign-up";
  const submitDisabled = isLoading || (authMode === "update-password" && !user);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setIsLoading(true);
    setNotice(null);

    try {
      if (authMode === "sign-up") {
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            emailRedirectTo: buildAuthRedirectUrl(redirectPath),
          },
        });

        if (error) {
          throw error;
        }

        if (data.session) {
          toast.success("Account created.");
          onSuccess?.();
        } else {
          setPendingVerificationEmail(email);
          setAuthMode("verify-email");
          setNotice("Finish email confirmation to unlock uploads and quote actions.");
          toast.success("Confirmation email sent.");
        }

        return;
      }

      if (authMode === "verify-email") {
        return;
      }

      if (authMode === "forgot-password") {
        await requestPasswordReset(email);
        setAuthMode("sign-in");
        setNotice(`Password reset email sent to ${email}.`);
        toast.success("Password reset email sent.");
        return;
      }

      if (authMode === "update-password") {
        if (!user) {
          throw new Error("Recovery session not ready. Reopen the reset link from your email.");
        }

        if (password.length < 8) {
          throw new Error("Password must be at least 8 characters.");
        }

        if (password !== confirmPassword) {
          throw new Error("Passwords do not match.");
        }

        await updateCurrentUserPassword(password);
        await refetch();
        toast.success("Password updated.");
        navigate("/", { replace: true });
        onSuccess?.();
        return;
      }

      const { error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (error) {
        if (isEmailNotConfirmedError(error)) {
          setPendingVerificationEmail(email);
          setAuthMode("verify-email");
          setNotice("This account still needs email confirmation before password sign-in can finish.");
          return;
        }

        throw error;
      }

      toast.success("Signed in successfully.");
      onSuccess?.();
    } catch (error: unknown) {
      toast.error(getErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  };

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

      await refetch();
      toast.success("Email verified.");
      onSuccess?.();
    } catch (error: unknown) {
      toast.error(getErrorMessage(error));
    } finally {
      setIsRefreshingVerification(false);
    }
  };

  const handleResendVerification = async () => {
    if (!pendingVerificationEmail) {
      toast.error("Enter your email again to resend confirmation.");
      setAuthMode("sign-up");
      return;
    }

    setIsResendingVerification(true);

    try {
      await resendSignupConfirmation(pendingVerificationEmail);
      toast.success(`Confirmation email resent to ${pendingVerificationEmail}.`);
    } catch (error: unknown) {
      toast.error(getErrorMessage(error));
    } finally {
      setIsResendingVerification(false);
    }
  };

  const handleChangeEmail = () => {
    setAuthMode("sign-up");
    setNotice(null);
    setPendingVerificationEmail("");
    setPassword("");
    setConfirmPassword("");
  };

  return (
    <section
      className={cn(
        "w-full rounded-[28px] border border-white/10 bg-[#0b0d10]/96 p-5 text-white shadow-[0_32px_80px_rgba(0,0,0,0.45)] backdrop-blur-2xl sm:p-6",
        className,
      )}
    >
      <div>
        <p className="text-[11px] font-medium uppercase tracking-[0.24em] text-white/40">
          {panelCopy.eyebrow}
        </p>
        <h2 className="mt-3 text-2xl font-semibold tracking-tight">{panelCopy.title}</h2>
        <p className="mt-2 text-sm leading-6 text-white/55">{panelCopy.description}</p>
      </div>

      {(authMode === "sign-in" || authMode === "sign-up") && (
        <div className="mt-5 grid grid-cols-2 rounded-full border border-white/10 bg-white/[0.03] p-1">
          <button
            type="button"
            className={cn(
              "rounded-full px-3 py-2 text-sm transition-colors",
              authMode === "sign-in"
                ? "bg-white text-black"
                : "text-white/60 hover:text-white",
            )}
            onClick={() => {
              setAuthMode("sign-in");
              setNotice(null);
            }}
          >
            Log in
          </button>
          <button
            type="button"
            className={cn(
              "rounded-full px-3 py-2 text-sm transition-colors",
              authMode === "sign-up"
                ? "bg-white text-black"
                : "text-white/60 hover:text-white",
            )}
            onClick={() => {
              setAuthMode("sign-up");
              setNotice(null);
            }}
          >
            Sign up
          </button>
        </div>
      )}

      {notice ? (
        <div className="mt-5 rounded-3xl border border-primary/20 bg-primary/10 px-4 py-3 text-sm text-primary">
          {notice}
        </div>
      ) : null}

      {authMode === "update-password" && !user ? (
        <div className="mt-5 rounded-3xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm text-white/65">
          Waiting for the recovery link to establish a session. If this does not clear, reopen the
          reset email and try again.
        </div>
      ) : null}

      {authMode === "verify-email" ? (
        <div className="mt-5">
          <EmailVerificationPrompt
            email={pendingVerificationEmail}
            isRefreshing={isRefreshingVerification}
            isResending={isResendingVerification}
            onRefreshSession={() => {
              void handleRefreshVerification();
            }}
            onResend={() => {
              void handleResendVerification();
            }}
            onChangeEmail={handleChangeEmail}
          />
        </div>
      ) : (
        <>
          {showSocialAuth ? (
            <>
              <SocialAuthButtons
                className="mt-5"
                buttonClassName="h-12 rounded-2xl border-white/10 bg-white/[0.03] text-white hover:bg-white/[0.07] hover:text-white"
                redirectPath={redirectPath}
              />

              <div className="relative my-5">
                <Separator className="bg-white/10" />
                <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-[#0b0d10] px-3 text-[11px] uppercase tracking-[0.24em] text-white/35">
                  Or with email
                </span>
              </div>
            </>
          ) : null}

          <form className="space-y-4" onSubmit={handleSubmit}>
            {showEmailField ? (
              <div className="space-y-2">
                <Label htmlFor="auth-email" className="text-white/70">
                  Email
                </Label>
                <Input
                  id="auth-email"
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  className="h-12 rounded-2xl border-white/10 bg-white/[0.03] px-4 text-white placeholder:text-white/35"
                  placeholder="your@company.com"
                  required
                />
              </div>
            ) : null}

            {showPasswordField ? (
              <div className="space-y-2">
                <Label htmlFor="auth-password" className="text-white/70">
                  {authMode === "update-password" ? "New password" : "Password"}
                </Label>
                <Input
                  id="auth-password"
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  className="h-12 rounded-2xl border-white/10 bg-white/[0.03] px-4 text-white placeholder:text-white/35"
                  placeholder="••••••••"
                  required
                />
              </div>
            ) : null}

            {showConfirmPasswordField ? (
              <div className="space-y-2">
                <Label htmlFor="auth-confirm-password" className="text-white/70">
                  Confirm new password
                </Label>
                <Input
                  id="auth-confirm-password"
                  type="password"
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                  className="h-12 rounded-2xl border-white/10 bg-white/[0.03] px-4 text-white placeholder:text-white/35"
                  placeholder="••••••••"
                  required
                />
              </div>
            ) : null}

            <Button
              type="submit"
              className="h-12 w-full rounded-2xl bg-primary text-primary-foreground hover:bg-primary/90"
              disabled={submitDisabled}
            >
              {isLoading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Working
                </>
              ) : (
                panelCopy.submitLabel
              )}
            </Button>
          </form>
        </>
      )}

      {authMode === "sign-in" ? (
        <>
          <button
            type="button"
            className="mt-5 text-sm text-white/55 transition-colors hover:text-white"
            onClick={() => {
              setAuthMode("forgot-password");
              setNotice(null);
            }}
          >
            Forgot password?
          </button>
          <p className="mt-4 text-sm text-white/55">
            Need an account?{" "}
            <button
              type="button"
              className="text-white transition-colors hover:text-primary"
              onClick={() => {
                setAuthMode("sign-up");
                setNotice(null);
              }}
            >
              Sign up
            </button>
          </p>
        </>
      ) : null}

      {authMode === "sign-up" ? (
        <p className="mt-5 text-sm text-white/55">
          Already have an account?{" "}
          <button
            type="button"
            className="text-white transition-colors hover:text-primary"
            onClick={() => {
              setAuthMode("sign-in");
              setNotice(null);
            }}
          >
            Log in
          </button>
        </p>
      ) : null}

      {authMode === "forgot-password" ? (
        <p className="mt-5 text-sm text-white/55">
          Remembered it?{" "}
          <button
            type="button"
            className="text-white transition-colors hover:text-primary"
            onClick={() => {
              setAuthMode("sign-in");
              setNotice(null);
            }}
          >
            Back to log in
          </button>
        </p>
      ) : null}

      {authMode === "verify-email" ? (
        <p className="mt-5 text-sm text-white/55">
          Need a different route?{" "}
          <button
            type="button"
            className="text-white transition-colors hover:text-primary"
            onClick={() => {
              setAuthMode("sign-in");
              setNotice(null);
              setPendingVerificationEmail("");
            }}
          >
            Back to log in
          </button>
        </p>
      ) : null}
    </section>
  );
}
