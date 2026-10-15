import { Button } from "@/components/ui/button";
import type { StepUpNotice } from "@/features/auth/use-aal2-step-up";

/** The OVD-771 step-up outcome shown under an admin write: cancelled, or enroll MFA first. */
export function StepUpNoticeBanner({
  notice,
  onEnroll,
}: Readonly<{ notice: StepUpNotice | null; onEnroll: () => void }>) {
  if (!notice) {
    return null;
  }

  return (
    <output className="block space-y-2">
      <p className="text-sm text-destructive">{notice.message}</p>
      {notice.kind === "enroll" ? (
        <Button type="button" variant="outline" size="sm" onClick={onEnroll}>
          Set up authenticator
        </Button>
      ) : null}
    </output>
  );
}
