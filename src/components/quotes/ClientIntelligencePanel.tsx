import { useEffect, useState, type ReactNode } from "react";
import { History, Info, MessageSquareText, Quote, Sparkles } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

export type IntelligencePanelTab = "quote" | "metadata" | "dfm" | "history" | "chat";

type ClientIntelligencePanelProps = {
  itemKey: string;
  quoteContent: ReactNode;
  metadataContent: ReactNode;
  dfmContent: ReactNode;
  historyContent: ReactNode;
  chatContent: ReactNode;
  defaultTab?: IntelligencePanelTab;
  className?: string;
};

const TAB_LABELS: Array<{
  value: IntelligencePanelTab;
  label: string;
  icon: typeof Quote;
}> = [
  { value: "quote", label: "Quote", icon: Quote },
  { value: "metadata", label: "Metadata", icon: Info },
  { value: "dfm", label: "DFM", icon: Sparkles },
  { value: "history", label: "History", icon: History },
  { value: "chat", label: "Quote log", icon: MessageSquareText },
];

export function ClientIntelligencePanel({
  itemKey,
  quoteContent,
  metadataContent,
  dfmContent,
  historyContent,
  chatContent,
  defaultTab = "quote",
  className,
}: ClientIntelligencePanelProps) {
  const [activeTab, setActiveTab] = useState<IntelligencePanelTab>(defaultTab);

  useEffect(() => {
    setActiveTab(defaultTab);
  }, [defaultTab, itemKey]);

  return (
    <aside className={cn("rounded-[30px] border border-white/8 bg-[#262626] p-5", className)}>
      <div className="border-b border-white/8 pb-4">
        <p className="text-xs uppercase tracking-[0.18em] text-white/35">Part context</p>
      </div>

      <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as IntelligencePanelTab)}>
        <TabsList className="mt-4 h-auto flex-wrap justify-start gap-2 rounded-[16px] bg-black/20 p-1.5">
          {TAB_LABELS.map((tab) => {
            const Icon = tab.icon;

            return (
              <TabsTrigger
                key={tab.value}
                value={tab.value}
                className="rounded-[12px] px-3 py-2 text-white/70 data-[state=active]:bg-white data-[state=active]:text-black"
              >
                <Icon className="mr-2 h-4 w-4" />
                {tab.label}
              </TabsTrigger>
            );
          })}
        </TabsList>

        <TabsContent value="quote" className="mt-4">
          {quoteContent}
        </TabsContent>
        <TabsContent value="metadata" className="mt-4">
          {metadataContent}
        </TabsContent>
        <TabsContent value="dfm" className="mt-4">
          {dfmContent}
        </TabsContent>
        <TabsContent value="history" className="mt-4">
          {historyContent}
        </TabsContent>
        <TabsContent value="chat" className="mt-4">
          {chatContent}
        </TabsContent>
      </Tabs>
    </aside>
  );
}
