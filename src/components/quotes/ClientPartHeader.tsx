import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

type ClientPartHeaderProps = {
  eyebrow?: string | null;
  title: string;
  description?: string | null;
  badges?: ReactNode;
  details?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
};

export function ClientPartHeader({
  eyebrow,
  title,
  description,
  badges = null,
  details = null,
  actions = null,
  children,
  className,
}: ClientPartHeaderProps) {
  return (
    <section
      className={cn(
        "rounded-[30px] border border-ws-border bg-ws-card px-5 py-5 md:px-6",
        className,
      )}
    >
      <div className="flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
        <div className="min-w-0 flex-1">
          {eyebrow ? <p className="ws-section-label">{eyebrow}</p> : null}
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-white">{title}</h1>
          {description ? <p className="mt-2 max-w-4xl text-sm text-white/55">{description}</p> : null}
          {badges ? <div className="mt-4 flex flex-wrap gap-2">{badges}</div> : null}
          {details ? <div className="mt-4">{details}</div> : null}
        </div>

        {actions ? <div className="flex flex-wrap items-center gap-2 xl:justify-end">{actions}</div> : null}
      </div>
      {children ? <div className="mt-5 border-t border-white/[0.06] pt-5">{children}</div> : null}
    </section>
  );
}
