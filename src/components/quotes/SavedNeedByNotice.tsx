import { Button } from "@/components/ui/button";
import { formatRequestedByDateLabel } from "@/features/quotes/request-intake";

type SavedNeedByNoticeProps = {
  requestedByDate: string;
  onRemove: () => void;
  disabled?: boolean;
};

/**
 * OVD-981: the controlled beta refuses any saved Need by date, so a date that
 * is already on the request blocks dispatch until the user removes it. The
 * results-side filter is view only and never sets or clears this date.
 */
export function SavedNeedByNotice({ requestedByDate, onRemove, disabled = false }: Readonly<SavedNeedByNoticeProps>) {
  const label = formatRequestedByDateLabel(requestedByDate) ?? requestedByDate;

  return (
    <section className="border-y border-paper-hairline bg-paper-inset px-4 py-3" aria-label="Need by date on the request">
      <p className="text-sm text-paper-ink">
        This request has a Need by date of <span className="font-mono">{label}</span>. The controlled beta does
        not support a Need by date, so quote requests are denied until it is removed.
      </p>
      <p className="mt-1 text-sm text-paper-muted">The Need by filter changes this view only.</p>
      <Button type="button" variant="outline" size="sm" className="mt-3 rounded-[2px]" disabled={disabled} onClick={onRemove}>
        Remove Need by from request
      </Button>
    </section>
  );
}
