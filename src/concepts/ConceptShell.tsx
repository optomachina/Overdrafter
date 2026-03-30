import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

type ConceptShellProps = {
  sidebarContent: ReactNode;
  headerTitle: string;
  headerBreadcrumb?: string;
  headerRight?: ReactNode;
  children: ReactNode;
  accentClass?: string;
};

function ConceptHeader({
  title,
  breadcrumb,
  right,
}: {
  title: string;
  breadcrumb?: string;
  right?: ReactNode;
}) {
  return (
    <header className="flex h-11 shrink-0 items-center justify-between gap-4 border-b border-white/[0.08] bg-ws-shell px-4">
      <div className="flex min-w-0 items-center gap-2 text-sm">
        {breadcrumb && (
          <>
            <span className="text-white/40">{breadcrumb}</span>
            <span className="text-white/25">/</span>
          </>
        )}
        <span className="truncate font-medium text-white/90">{title}</span>
      </div>
      {right && <div className="flex shrink-0 items-center gap-2">{right}</div>}
    </header>
  );
}

export function ConceptShell({
  sidebarContent,
  headerTitle,
  headerBreadcrumb,
  headerRight,
  children,
  accentClass,
}: ConceptShellProps) {
  return (
    <div className={cn("flex h-screen w-full overflow-hidden bg-ws-overlay text-white", accentClass)}>
      <aside className="flex h-full w-[220px] shrink-0 flex-col border-r border-white/[0.08] bg-ws-shell">
        {sidebarContent}
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <ConceptHeader
          title={headerTitle}
          breadcrumb={headerBreadcrumb}
          right={headerRight}
        />
        <main className="min-h-0 flex-1 overflow-auto bg-ws-base">
          {children}
        </main>
      </div>
    </div>
  );
}
