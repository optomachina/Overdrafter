import { useState } from "react";
import { TopBar } from "@/components/TopBar";
import { LeftDrawer } from "@/components/LeftDrawer";
import { HeroPromptBox } from "@/components/HeroPromptBox";

const Index = () => {
  const [isCollapsed, setIsCollapsed] = useState(false);

  return (
    <div className="min-h-screen flex bg-background">
      <LeftDrawer isCollapsed={isCollapsed} onToggle={() => setIsCollapsed(!isCollapsed)} />
      
      <div className="flex-1 flex flex-col">
        <TopBar onMenuClick={() => setIsCollapsed(!isCollapsed)} showMenuButton={false} />

        <main className="flex-1 flex items-center justify-center pt-16 pb-20 px-4 pl-16">
          <HeroPromptBox />
        </main>

      </div>
    </div>
  );
};

export default Index;
