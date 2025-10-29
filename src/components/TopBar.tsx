import { Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useState } from "react";
import { SignInDialog } from "./SignInDialog";

interface TopBarProps {
  onMenuClick: () => void;
}

export function TopBar({ onMenuClick }: TopBarProps) {
  const [showSignIn, setShowSignIn] = useState(false);

  return (
    <>
      <header className="fixed top-0 left-0 right-0 h-16 z-50 glass-header border-b border-border/50">
        <div className="h-full px-4 flex items-center justify-between max-w-[1920px] mx-auto">
          <Button
            variant="ghost"
            size="icon"
            onClick={onMenuClick}
            className="hover:bg-secondary"
            aria-label="Open menu"
          >
            <Menu className="h-5 w-5" />
          </Button>

          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              className="rounded-full hover:bg-secondary hover:text-primary transition-colors"
              onClick={() => setShowSignIn(true)}
            >
              Sign in
            </Button>
            <Button
              variant="default"
              className="rounded-full bg-foreground text-background hover:bg-foreground/90 transition-colors"
              onClick={() => setShowSignIn(true)}
            >
              Sign up
            </Button>
          </div>
        </div>
      </header>

      <SignInDialog open={showSignIn} onOpenChange={setShowSignIn} />
    </>
  );
}
