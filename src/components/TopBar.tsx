import { Button } from "@/components/ui/button";
import { useState, useEffect } from "react";
import { SignInDialog } from "./SignInDialog";
import { PanelLeft } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { User } from "@supabase/supabase-js";

interface TopBarProps {
  onMenuClick: () => void;
  showMenuButton?: boolean;
}

export function TopBar({ onMenuClick, showMenuButton = true }: TopBarProps) {
  const [showSignIn, setShowSignIn] = useState(false);
  const [user, setUser] = useState<User | null>(null);

  useEffect(() => {
    // Get initial session
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user ?? null);
    });

    // Listen for auth changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
    });

    return () => subscription.unsubscribe();
  }, []);

  return (
    <>
      <header className="fixed top-0 left-0 right-0 h-16 z-50 bg-background">
        <div className="h-full px-4 flex items-center w-full max-w-[1920px] mx-auto">
          {showMenuButton && (
            <Button
              variant="ghost"
              size="icon"
              onClick={onMenuClick}
              className="hover:bg-secondary"
              aria-label="Open menu"
            >
              <PanelLeft className="h-6 w-6" />
            </Button>
          )}

          <div className="ml-auto flex items-center gap-2">
            {!user && (
              <>
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
              </>
            )}
          </div>
        </div>
      </header>

      <SignInDialog open={showSignIn} onOpenChange={setShowSignIn} />
    </>
  );
}
