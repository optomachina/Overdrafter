import type { ReactNode } from "react";
import {
  ArrowUp,
  Boxes,
  FileSpreadsheet,
  FolderSearch2,
  Plus,
  ScanSearch,
  ShieldCheck,
  Sparkles,
  UploadCloud,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type GuestAppShellProps = {
  authOpen?: boolean;
  heading?: string;
  panel?: ReactNode;
  reservePanelSpace?: boolean;
  subtitle?: string;
  onOpenAuth: (mode: "signin" | "signup") => void;
};

const navItems = [
  { label: "New quote", icon: Plus },
  { label: "Search jobs", icon: FolderSearch2 },
  { label: "Imports", icon: UploadCloud },
  { label: "Vendor runs", icon: ScanSearch },
  { label: "Packages", icon: Boxes },
];

const quickPrompts = [
  "Upload a drawing package",
  "Compare supplier responses",
  "Review a published quote",
];

export function GuestAppShell({
  authOpen = false,
  heading = "What are you quoting today?",
  panel,
  reservePanelSpace = false,
  subtitle = "Upload drawings, organize work, and publish client-ready quote packages from one account.",
  onOpenAuth,
}: GuestAppShellProps) {
  const openSignIn = () => onOpenAuth("signin");
  const openSignUp = () => onOpenAuth("signup");

  return (
    <div className="min-h-screen overflow-hidden bg-[radial-gradient(circle_at_top,hsl(var(--primary)/0.14),transparent_22%),linear-gradient(180deg,#17181c_0%,#121317_42%,#0e1013_100%)] text-foreground">
      <div className="flex min-h-screen">
        <aside className="hidden w-[250px] flex-col border-r border-white/8 bg-[#0b0d10]/88 px-4 py-5 backdrop-blur xl:flex">
          <div>
            <div className="flex items-center gap-3 rounded-2xl px-2 py-1">
              <div className="flex h-10 w-10 items-center justify-center rounded-2xl border border-white/10 bg-white/[0.04]">
                <FileSpreadsheet className="h-5 w-5 text-white" />
              </div>
              <div>
                <p className="text-sm font-medium text-white/70">OverDrafter</p>
                <p className="text-sm text-white">Curated CNC Quotes</p>
              </div>
            </div>

            <nav className="mt-8 space-y-1">
              {navItems.map((item) => (
                <button
                  key={item.label}
                  type="button"
                  className="flex w-full items-center gap-3 rounded-2xl px-3 py-3 text-left text-sm text-white/72 transition-colors hover:bg-white/[0.05] hover:text-white"
                  onClick={openSignIn}
                >
                  <item.icon className="h-4 w-4" />
                  <span>{item.label}</span>
                </button>
              ))}
            </nav>
          </div>

          <div className="mt-auto rounded-[28px] border border-white/10 bg-white/[0.03] p-4">
            <div className="flex items-center gap-2 text-primary">
              <ShieldCheck className="h-4 w-4" />
              <span className="text-xs font-medium uppercase tracking-[0.24em] text-white/45">
                Secure account
              </span>
            </div>
            <p className="mt-4 text-sm font-medium text-white">Get responses tailored to your team.</p>
            <p className="mt-2 text-sm leading-6 text-white/55">
              Sign in to upload CAD, save quote reviews, and publish packages without leaving the app.
            </p>
            <Button
              className="mt-4 h-11 w-full rounded-full bg-white text-black hover:bg-white/90"
              onClick={openSignIn}
            >
              Log in
            </Button>
          </div>
        </aside>

        <div className="relative flex min-h-screen flex-1 flex-col">
          <header className="relative z-10 flex items-center justify-between px-4 py-4 sm:px-6">
            <div className="flex items-center gap-3 xl:hidden">
              <div className="flex h-10 w-10 items-center justify-center rounded-2xl border border-white/10 bg-white/[0.04]">
                <FileSpreadsheet className="h-5 w-5 text-white" />
              </div>
              <div>
                <p className="text-sm font-medium text-white">OverDrafter</p>
                <p className="text-xs text-white/45">Curated CNC Quotes</p>
              </div>
            </div>

            <div className="ml-auto flex items-center gap-2 sm:gap-3">
              <Button
                variant="outline"
                className="h-10 rounded-full border-white/12 bg-white/[0.03] px-4 text-white hover:bg-white/[0.08] hover:text-white"
                onClick={openSignIn}
              >
                Log in
              </Button>
              <Button
                className="h-10 rounded-full bg-white text-black hover:bg-white/90"
                onClick={openSignUp}
              >
                Sign up for free
              </Button>
            </div>
          </header>

          <main className="relative flex flex-1 flex-col justify-center px-4 pb-10 pt-6 sm:px-6">
            <div
              className={cn(
                "mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center",
                panel && reservePanelSpace && "xl:max-w-5xl xl:pr-[430px]",
              )}
            >
              <div className="mx-auto w-full max-w-2xl text-center">
                <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-4 py-2 text-sm text-white/55">
                  <Sparkles className="h-4 w-4 text-primary" />
                  Quote intake, review, and publishing in one flow
                </div>

                <h1 className="mt-8 text-4xl font-semibold tracking-tight text-white sm:text-5xl">
                  {heading}
                </h1>
                <p className="mx-auto mt-4 max-w-xl text-base leading-7 text-white/58 sm:text-lg">
                  {subtitle}
                </p>

                <button
                  type="button"
                  className={cn(
                    "group mt-8 flex w-full items-center gap-3 rounded-[28px] border border-white/10 bg-white/[0.04] px-4 py-4 text-left shadow-[0_24px_60px_rgba(0,0,0,0.22)] transition-all hover:border-white/18 hover:bg-white/[0.06]",
                    authOpen && "border-primary/35 bg-white/[0.06]",
                  )}
                  onClick={openSignIn}
                >
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white/[0.06] text-white/75">
                    <Plus className="h-5 w-5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm text-white/42">Ask anything</span>
                    <span className="block truncate text-base text-white/78">
                      Describe a part, upload a drawing, or review a package
                    </span>
                  </span>
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white/[0.06] text-white/70 transition-colors group-hover:bg-primary group-hover:text-white">
                    <ArrowUp className="h-5 w-5" />
                  </span>
                </button>

                <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
                  {quickPrompts.map((prompt) => (
                    <button
                      key={prompt}
                      type="button"
                      className="rounded-full border border-white/10 bg-white/[0.03] px-4 py-2 text-sm text-white/60 transition-colors hover:border-white/20 hover:text-white"
                      onClick={openSignIn}
                    >
                      {prompt}
                    </button>
                  ))}
                </div>
              </div>
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

          <footer className="px-4 pb-5 text-center text-xs text-white/35 sm:px-6">
            By continuing, you agree to the service terms and privacy policy.
          </footer>
        </div>
      </div>
    </div>
  );
}
