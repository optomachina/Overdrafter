import type { ReactNode } from "react";
import { NavLink, useLocation, useSearchParams } from "react-router-dom";
import { Box, FileText, Search } from "lucide-react";
import { cn } from "@/lib/utils";

type QuoteIntelligenceShellProps = {
  title: string;
  eyebrow?: string;
  description?: string;
  uploadSlot?: ReactNode;
  accountSlot?: ReactNode;
  children: ReactNode;
  contentClassName?: string;
};

const DESTINATIONS = [
  { href: "/parts", label: "Parts", icon: Box },
  { href: "/quotes", label: "Quotes", icon: FileText },
  { href: "/search", label: "Search", icon: Search },
] as const;

function DestinationNavigation({ mobile = false }: { mobile?: boolean }) {
  const location = useLocation();

  return (
    <nav aria-label="Primary" className={mobile ? "grid grid-cols-3" : "flex h-full items-stretch"}>
      {DESTINATIONS.map(({ href, label, icon: Icon }) => {
        const active = location.pathname === href || location.pathname.startsWith(`${href}/`);

        return (
          <NavLink
            key={href}
            to={href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "group flex min-h-11 items-center justify-center gap-2 border-transparent px-4 text-[13px] font-medium text-paper-muted transition-colors hover:text-paper-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-paper-red",
              mobile ? "flex-col gap-1 border-t py-2 text-[10px]" : "border-b-2",
              active && "border-paper-red text-paper-ink",
            )}
          >
            <Icon className="h-4 w-4" aria-hidden="true" />
            <span>{label}</span>
          </NavLink>
        );
      })}
    </nav>
  );
}

export function QuoteIntelligenceShell({
  title,
  eyebrow,
  description,
  uploadSlot,
  accountSlot,
  children,
  contentClassName,
}: QuoteIntelligenceShellProps) {
  const [searchParams] = useSearchParams();
  const isIosApp = searchParams.get("app") === "ios";

  return (
    <div className="min-h-svh bg-paper text-paper-ink">
      <header className="sticky top-0 z-40 border-b border-paper-hairline bg-paper/95 backdrop-blur-sm">
        <div className="mx-auto flex h-14 w-full max-w-[1440px] items-center gap-4 px-4 sm:px-6">
          <NavLink
            to={isIosApp ? "/parts?app=ios" : "/"}
            className="shrink-0 font-display text-[14px] font-bold uppercase tracking-[-0.04em] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-paper-red"
          >
            OverDrafter
          </NavLink>
          {!isIosApp ? <div className="hidden h-full md:block"><DestinationNavigation /></div> : null}
          <div className="ml-auto flex min-w-0 items-center gap-2">
            {uploadSlot}
            {accountSlot}
          </div>
        </div>
      </header>

      <main
        className={cn(
          "mx-auto w-full max-w-[1440px] px-4 pb-[calc(6rem+env(safe-area-inset-bottom))] pt-8 sm:px-6 md:pb-12 md:pt-10",
          contentClassName,
        )}
      >
        <div className="mb-7 border-b border-paper-hairline pb-5">
          {eyebrow ? (
            <p className="mb-2 font-mono text-micro uppercase text-paper-muted">{eyebrow}</p>
          ) : null}
          <h1 className="font-display text-[30px] font-bold leading-none tracking-[-0.04em] sm:text-[38px]">
            {title}
          </h1>
          {description ? <p className="mt-3 max-w-2xl text-body-sm text-paper-muted">{description}</p> : null}
        </div>
        {children}
      </main>

      {!isIosApp ? (
        <div
          className="fixed inset-x-0 bottom-0 z-40 border-t border-paper-hairline bg-paper/95 backdrop-blur-sm md:hidden"
          style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
        >
          <DestinationNavigation mobile />
        </div>
      ) : null}
    </div>
  );
}
