import { useState, useEffect } from "react";
import { TopBar } from "@/components/TopBar";
import { LeftDrawer } from "@/components/LeftDrawer";
import { HeroPromptBox } from "@/components/HeroPromptBox";

const Index = () => {
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);

  // Close drawer on ESC key
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isDrawerOpen) {
        setIsDrawerOpen(false);
      }
    };

    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [isDrawerOpen]);

  // Prevent body scroll when drawer is open
  useEffect(() => {
    if (isDrawerOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [isDrawerOpen]);

  return (
    <div className="min-h-screen flex flex-col bg-background">
      <TopBar onMenuClick={() => setIsDrawerOpen(true)} isDrawerOpen={isDrawerOpen} />
      <LeftDrawer isOpen={isDrawerOpen} onClose={() => setIsDrawerOpen(false)} />

      <main className="flex-1 flex items-center justify-center pt-16 pb-20 px-4">
        <HeroPromptBox />
      </main>

      <footer className="py-6 px-4 border-t border-border/50 text-center">
        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4">
          <p className="text-sm text-muted-foreground">
            © {new Date().getFullYear()} OverDrafter
          </p>
          <div className="flex items-center gap-4 text-sm text-muted-foreground">
            <a href="#" className="hover:text-primary transition-colors">Privacy</a>
            <span>·</span>
            <a href="#" className="hover:text-primary transition-colors">Terms</a>
            <span>·</span>
            <a href="#" className="hover:text-primary transition-colors">Contact</a>
          </div>
        </div>
      </footer>
    </div>
  );
};

export default Index;
