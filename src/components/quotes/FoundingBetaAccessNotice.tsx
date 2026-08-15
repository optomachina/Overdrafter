import { ExternalLink, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  FOUNDING_BETA_SUPPORT_EMAIL,
  getFoundingBetaUploadMessage,
} from "@/features/quotes/founding-beta-access";
import { useFoundingBetaAccess } from "@/features/quotes/use-founding-beta-access";

type FoundingBetaAccessNoticeProps = Readonly<{
  organizationId?: string;
  userId?: string;
  enabled?: boolean;
  className?: string;
}>;

export function FoundingBetaAccessNotice({
  organizationId,
  userId,
  enabled = true,
  className = "",
}: FoundingBetaAccessNoticeProps) {
  if (!enabled || !organizationId || !userId) {
    return null;
  }

  return (
    <ConnectedFoundingBetaAccessNotice
      organizationId={organizationId}
      userId={userId}
      className={className}
    />
  );
}

function ConnectedFoundingBetaAccessNotice({
  organizationId,
  userId,
  className,
}: Readonly<Required<Pick<FoundingBetaAccessNoticeProps, "organizationId" | "userId" | "className">>>) {
  const access = useFoundingBetaAccess({ organizationId, userId, enabled: true });

  if (access.status === "eligible") {
    return null;
  }

  const handleAccept = async () => {
    try {
      await access.acceptNotice();
      toast.success("Founding Beta notice accepted. New-part access is ready.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to accept the current notice.");
    }
  };

  return (
    <section
      aria-live="polite"
      className={`border-y border-border bg-muted px-4 py-3 text-sm text-foreground md:px-6 ${className}`.trim()}
    >
      <p className="font-medium">Founding Beta new-part access</p>
      <p className="mt-1 text-muted-foreground">{getFoundingBetaUploadMessage(access.status)}</p>
      {access.status === "notice_required" && access.access ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <a className="underline underline-offset-4" href={access.access.termsPath} target="_blank" rel="noreferrer">
            Beta terms <ExternalLink className="ml-1 inline h-3 w-3" aria-hidden="true" />
          </a>
          <a className="underline underline-offset-4" href={access.access.privacyPath} target="_blank" rel="noreferrer">
            Privacy
          </a>
          <Button type="button" size="sm" onClick={() => void handleAccept()} disabled={access.isAcceptingNotice}>
            {access.isAcceptingNotice ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> : null}
            Accept current notice
          </Button>
        </div>
      ) : null}
      {access.status === "not_enrolled" || access.status === "revoked" || access.status === "unavailable" ? (
        <a className="mt-2 inline-block underline underline-offset-4" href={`mailto:${FOUNDING_BETA_SUPPORT_EMAIL}`}>
          Contact support
        </a>
      ) : null}
    </section>
  );
}
