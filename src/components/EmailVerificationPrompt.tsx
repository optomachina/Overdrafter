import { Loader2, MailCheck } from "lucide-react";
import { Button } from "@/components/ui/button";

type EmailVerificationPromptProps = {
  email: string;
  isRefreshing?: boolean;
  isResending?: boolean;
  onChangeEmail: () => void;
  onRefreshSession: () => void;
  onResend: () => void;
};

export function EmailVerificationPrompt({
  email,
  isRefreshing = false,
  isResending = false,
  onChangeEmail,
  onRefreshSession,
  onResend,
}: EmailVerificationPromptProps) {
  return (
    <div className="space-y-4">
      <div className="rounded-3xl border border-primary/20 bg-primary/10 p-5 text-primary">
        <div className="flex items-start gap-3">
          <MailCheck className="mt-0.5 h-5 w-5 shrink-0" />
          <div>
            <p className="font-medium">Verify your email to continue</p>
            <p className="mt-2 text-sm text-primary/90">
              We sent a confirmation link to <span className="font-medium">{email}</span>. Once the link is
              opened, return here and continue without creating a second password session.
            </p>
          </div>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Button
          type="button"
          className="rounded-full"
          onClick={onRefreshSession}
          disabled={isRefreshing || isResending}
        >
          {isRefreshing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
          I already clicked the email
        </Button>
        <Button
          type="button"
          variant="outline"
          className="rounded-full border-white/10 bg-white/5"
          onClick={onResend}
          disabled={isRefreshing || isResending}
        >
          {isResending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
          Resend email
        </Button>
      </div>

      <button
        type="button"
        className="text-sm text-white/55 hover:text-white hover:underline"
        onClick={onChangeEmail}
        disabled={isRefreshing || isResending}
      >
        Use a different email address
      </button>
    </div>
  );
}
