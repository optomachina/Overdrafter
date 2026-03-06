import { type ReactNode } from "react";
import { Menu } from "lucide-react";
import logo from "@/assets/logo.png";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";

type ChatWorkspaceLayoutProps = {
  topRightContent?: ReactNode;
  sidebarContent: ReactNode;
  sidebarFooter?: ReactNode;
  children: ReactNode;
};

function SidebarScaffold({
  sidebarContent,
  sidebarFooter,
}: Pick<ChatWorkspaceLayoutProps, "sidebarContent" | "sidebarFooter">) {
  return (
    <div className="flex h-full flex-col bg-[#171717] text-white">
      <div className="flex items-center gap-3 px-4 py-4">
        <div className="grid h-8 w-8 place-items-center rounded-lg bg-white/[0.03]">
          <img src={logo} alt="OverDrafter logo" className="h-6 w-6 object-contain" />
        </div>
        <div className="min-w-0">
          <p className="truncate text-base font-semibold">OverDrafter</p>
          <p className="truncate text-xs text-white/45">v{__APP_VERSION__}</p>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">{sidebarContent}</div>

      {sidebarFooter ? <div className="border-t border-white/6 px-3 py-4">{sidebarFooter}</div> : null}
    </div>
  );
}

export function ChatWorkspaceLayout({
  topRightContent,
  sidebarContent,
  sidebarFooter,
  children,
}: ChatWorkspaceLayoutProps) {
  return (
    <div className="min-h-screen bg-[#212121] text-white">
      <div className="flex min-h-screen">
        <aside className="hidden w-[260px] shrink-0 border-r border-white/6 md:block">
          <SidebarScaffold sidebarContent={sidebarContent} sidebarFooter={sidebarFooter} />
        </aside>

        <div className="flex min-h-screen flex-1 flex-col">
          <header className="flex items-center justify-between px-4 py-3 md:px-6">
            <Sheet>
              <SheetTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="rounded-full text-white/75 hover:bg-white/6 hover:text-white md:hidden"
                >
                  <Menu className="h-5 w-5" />
                  <span className="sr-only">Open sidebar</span>
                </Button>
              </SheetTrigger>
              <SheetContent
                side="left"
                className="w-[280px] border-r border-white/10 bg-[#171717] p-0 text-white sm:max-w-[280px]"
              >
                <SidebarScaffold sidebarContent={sidebarContent} sidebarFooter={sidebarFooter} />
              </SheetContent>
            </Sheet>

            <div className="flex-1 md:hidden" />
            <div className="ml-auto flex items-center gap-2">{topRightContent}</div>
          </header>

          <main className="flex flex-1 flex-col">{children}</main>
        </div>
      </div>
    </div>
  );
}
