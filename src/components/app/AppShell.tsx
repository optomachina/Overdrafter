import { type ReactNode, useState } from "react";
import { NavLink } from "react-router-dom";
import {
  ChevronLeft,
  ChevronRight,
  FileSpreadsheet,
  LayoutDashboard,
  PanelLeft,
  PlusSquare,
  ShieldCheck,
  UserRound,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { useAppSession } from "@/hooks/use-app-session";
import { formatStatusLabel } from "@/features/quotes/utils";

type AppShellProps = {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  sidebarContent?: ReactNode;
  sidebarTitle?: string;
  variant?: "default" | "client-chat";
  children: ReactNode;
};

export function AppShell({
  title,
  subtitle,
  actions,
  sidebarContent,
  sidebarTitle = "Navigation",
  variant = "default",
  children,
}: AppShellProps) {
  const [collapsed, setCollapsed] = useState(false);
  const { user, activeMembership } = useAppSession();

  const navItems = [
    { to: "/", label: activeMembership?.role === "client" ? "Projects" : "Dashboard", icon: LayoutDashboard },
    ...(activeMembership ? [{ to: "/jobs/new", label: "New Job", icon: PlusSquare }] : []),
  ];
  const isClientChat = variant === "client-chat";

  return (
    <div
      className={cn(
        "min-h-screen text-foreground",
        isClientChat
          ? "bg-[#111214]"
          : "bg-[radial-gradient(circle_at_top,hsl(var(--primary)/0.14),transparent_30%),linear-gradient(180deg,hsl(var(--background)),hsl(220_16%_7%))]",
      )}
    >
      <div className="mx-auto flex min-h-screen w-full max-w-[1680px]">
        <aside
          className={cn(
            "sticky top-0 hidden h-screen shrink-0 border-r backdrop-blur md:flex md:flex-col",
            isClientChat
              ? "border-white/5 bg-[#17181b]/95"
              : "border-white/8 bg-[#0d0f12]/95",
            collapsed ? "w-20" : "w-[19rem]",
          )}
        >
          <div className="flex items-center justify-between px-4 py-5">
            <div className={cn("flex items-center gap-3", collapsed && "justify-center")}>
              <div className="flex h-10 w-10 items-center justify-center rounded-2xl border border-white/10 bg-white/[0.06]">
                <FileSpreadsheet className="h-5 w-5 text-primary" />
              </div>
              {!collapsed && (
                <div>
                  <p className="text-sm font-medium text-white/70">OverDrafter</p>
                  <p className="font-semibold tracking-tight text-white">Curated CNC Quotes</p>
                </div>
              )}
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="text-white/60 hover:bg-white/5 hover:text-white"
              onClick={() => setCollapsed((value) => !value)}
            >
              {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
            </Button>
          </div>
          <div className="mt-6 flex min-h-0 flex-1 flex-col px-3">
            <nav className="space-y-1">
              {navItems.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  className={({ isActive }) =>
                    cn(
                      "flex items-center gap-3 rounded-2xl px-3 py-3 text-sm font-medium transition-colors",
                      isActive
                        ? isClientChat
                          ? "bg-white/[0.1] text-white"
                          : "bg-white/[0.07] text-white"
                        : "text-white/65 hover:bg-white/5 hover:text-white",
                      collapsed && "justify-center px-0",
                    )
                  }
                >
                  <item.icon className="h-4 w-4" />
                  {!collapsed && item.label}
                </NavLink>
              ))}
            </nav>

            {!collapsed && sidebarContent ? (
              <div className="mt-6 min-h-0 flex-1 overflow-y-auto pb-4 pr-1">
                {sidebarContent}
              </div>
            ) : (
              <div className="flex-1" />
            )}
          </div>

          <div className="px-4 pb-4">
            <Separator className="bg-white/10" />
            <div className={cn("mt-4 flex items-center gap-3", collapsed && "justify-center")}>
              <div className="flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-white/[0.05]">
                {activeMembership?.role === "client" ? (
                  <UserRound className="h-4 w-4 text-white/70" />
                ) : (
                  <ShieldCheck className="h-4 w-4 text-primary" />
                )}
              </div>
              {!collapsed && (
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{user?.email ?? "Signed out"}</p>
                  <p className="truncate text-xs text-white/45">
                    {activeMembership ? formatStatusLabel(activeMembership.role) : "Verification pending"}
                  </p>
                </div>
              )}
            </div>
          </div>
        </aside>

        <div className="flex min-h-screen flex-1 flex-col">
          <header
            className={cn(
              "sticky top-0 z-20 border-b backdrop-blur-xl",
              isClientChat
                ? "border-white/5 bg-[#111214]/92"
                : "border-white/8 bg-background/80",
            )}
          >
            <div
              className={cn(
                "flex flex-col gap-4 px-6 md:px-8 lg:flex-row lg:items-center lg:justify-between",
                isClientChat ? "py-4" : "py-5",
              )}
            >
              <div>
                {sidebarContent ? (
                  <Sheet>
                    <SheetTrigger asChild>
                      <Button
                        variant="outline"
                        size="icon"
                        className="border-white/10 bg-white/[0.04] md:hidden"
                      >
                        <PanelLeft className="h-4 w-4" />
                        <span className="sr-only">Open sidebar</span>
                      </Button>
                    </SheetTrigger>
                    <SheetContent
                      side="left"
                      className="w-[22rem] border-r border-white/10 bg-[#0d0f12] p-0 text-white sm:max-w-[22rem]"
                    >
                      <SheetHeader className="border-b border-white/10 px-6 py-5">
                        <SheetTitle className="text-white">{sidebarTitle}</SheetTitle>
                      </SheetHeader>
                      <div className="h-full overflow-y-auto px-4 py-5">
                        {sidebarContent}
                      </div>
                    </SheetContent>
                  </Sheet>
                ) : null}
                <h1
                  className={cn(
                    "mt-3 tracking-tight",
                    isClientChat ? "text-[1.7rem] font-medium" : "text-3xl font-semibold",
                  )}
                >
                  {title}
                </h1>
                {subtitle ? (
                  <p className={cn("mt-2 max-w-3xl text-sm text-white/55", isClientChat && "max-w-2xl")}>
                    {subtitle}
                  </p>
                ) : null}
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-3">{actions}</div>
            </div>
          </header>

          <main className={cn("flex-1 px-6 md:px-8", isClientChat ? "py-6" : "py-8")}>{children}</main>
        </div>
      </div>
    </div>
  );
}
