import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";

type ClientShellSectionProps = HTMLAttributes<HTMLElement> & {
  readonly actions?: ReactNode;
  readonly description?: ReactNode;
  readonly title?: ReactNode;
};

export function ClientShellSection({
  actions,
  children,
  className,
  description,
  title,
  ...props
}: ClientShellSectionProps) {
  return (
    <section
      aria-label={typeof title === "string" ? title : undefined}
      className={cn("border-b border-paper-hairline py-5", className)}
      {...props}
    >
      {title || description || actions ? (
        <div className="mb-4 flex min-w-0 items-start justify-between gap-4">
          <div className="min-w-0">
            {title ? <h2 className="text-[14px] font-semibold text-paper-ink">{title}</h2> : null}
            {description ? <p className="mt-1 text-[12px] text-paper-muted">{description}</p> : null}
          </div>
          {actions ? <div className="shrink-0">{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

type ClientShellPanelProps = HTMLAttributes<HTMLElement>;

export function ClientShellPanel({ children, className, ...props }: ClientShellPanelProps) {
  return (
    <section
      className={cn("rounded-[4px] border border-paper-hairline bg-paper-surface", className)}
      {...props}
    >
      {children}
    </section>
  );
}

type ClientActionNoticeProps = HTMLAttributes<HTMLDivElement> & {
  readonly action?: ReactNode;
  readonly detail?: ReactNode;
  readonly title: ReactNode;
};

export function ClientActionNotice({
  action,
  className,
  detail,
  title,
  ...props
}: ClientActionNoticeProps) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-3 rounded-[2px] border border-paper-hairline border-l-2 border-l-paper-red bg-paper-surface p-3 sm:flex-row sm:items-center sm:justify-between",
        className,
      )}
      {...props}
    >
      <div className="min-w-0">
        <p className="text-[13px] font-medium text-paper-ink">{title}</p>
        {detail ? <p className="mt-1 text-[12px] text-paper-muted">{detail}</p> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}
