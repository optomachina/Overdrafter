import { PanelLeftClose, PanelLeftOpen, FileText, MoreHorizontal, Search, Library, ChevronRight, User, Crown, ShoppingBag, Settings, HelpCircle, Download, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { useState, useEffect } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import logo from "@/assets/logo.png";
import { supabase } from "@/integrations/supabase/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

interface LeftDrawerProps {
  isCollapsed: boolean;
  onToggle: () => void;
}

interface StorageFile {
  name: string;
  created_at: string;
  id: string;
  updated_at: string;
  last_accessed_at: string;
  metadata: Record<string, any>;
}

export function LeftDrawer({ isCollapsed, onToggle }: LeftDrawerProps) {
  const queryClient = useQueryClient();
  const [isCollapsedHeaderHovered, setIsCollapsedHeaderHovered] = useState<boolean>(false);
  const [isFilesOpen, setIsFilesOpen] = useState<boolean>(() => {
    try {
      if (typeof window === "undefined") return true;
      const stored = window.localStorage.getItem("leftDrawer.filesOpen");
      return stored === null ? true : stored === "1";
    } catch {
      return true;
    }
  });
  const [isMobile, setIsMobile] = useState<boolean>(() => {
    try {
      if (typeof window === "undefined") return false;
      return window.matchMedia("(max-width: 768px)").matches;
    } catch {
      return false;
    }
  });

  // Fetch user's uploaded files
  const { data: files = [], isLoading } = useQuery({
    queryKey: ['user-files'],
    queryFn: async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return [];

      const { data, error } = await supabase.storage
        .from('uploads')
        .list(user.id, {
          limit: 100,
          sortBy: { column: 'created_at', order: 'desc' }
        });

      if (error) throw error;
      return (data || []) as StorageFile[];
    },
    refetchInterval: 5000, // Refetch every 5 seconds
  });

  // Ensure hover state doesn't persist across open/close transitions
  useEffect(() => {
    setIsCollapsedHeaderHovered(false);
  }, [isCollapsed]);

  // Detect mobile viewport for off-canvas behavior
  useEffect(() => {
    const query = window.matchMedia("(max-width: 768px)");
    const update = () => setIsMobile(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  // Persist accordion open states
  useEffect(() => {
    try {
      window.localStorage.setItem("leftDrawer.filesOpen", isFilesOpen ? "1" : "0");
    } catch {}
  }, [isFilesOpen]);

  const handleDeleteFile = async (fileName: string) => {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      const filePath = `${user.id}/${fileName}`;
      const { error } = await supabase.storage
        .from('uploads')
        .remove([filePath]);

      if (error) throw error;

      toast.success("File deleted successfully");
      queryClient.invalidateQueries({ queryKey: ['user-files'] });
    } catch (error) {
      console.error('Delete error:', error);
      toast.error("Failed to delete file");
    }
  };

  const handleDownloadFile = async (fileName: string) => {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      const filePath = `${user.id}/${fileName}`;
      const { data, error } = await supabase.storage
        .from('uploads')
        .download(filePath);

      if (error) throw error;

      // Create download link
      const url = URL.createObjectURL(data);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName.split('-').slice(1).join('-'); // Remove timestamp prefix
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      toast.success("File downloaded");
    } catch (error) {
      console.error('Download error:', error);
      toast.error("Failed to download file");
    }
  };

  const getFileExtension = (fileName: string) => {
    const parts = fileName.split('.');
    return parts.length > 1 ? parts[parts.length - 1].toUpperCase() : 'FILE';
  };

  // Mobile: show as off-canvas sheet
  if (isMobile) {
    return (
      <Sheet open={!isCollapsed} onOpenChange={() => onToggle()}>
        <SheetContent
          side="left"
          className="p-0 w-[80vw] max-w-sm bg-background border-r border-border [&>button]:hidden"
          aria-label="Navigation drawer"
          id="stage-slideover-sidebar"
        >
          <div className="h-full flex flex-col">
            {/* Header */}
            <div className="h-14 flex items-center justify-between px-4">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg overflow-hidden flex items-center justify-center">
                  <img src={logo} alt="OverDrafter" className="w-full h-full object-contain" />
                </div>
                <span className="font-semibold text-foreground">OverDrafter</span>
              </div>
              <Button
                variant="ghost"
                size="icon"
                onClick={onToggle}
                className="hover:bg-secondary"
                aria-label="Close sidebar"
                aria-controls="stage-slideover-sidebar"
                aria-expanded={!isCollapsed}
              >
                <PanelLeftClose className="h-5 w-5" />
              </Button>
            </div>

            {/* Content (reuse expanded content branch) */}
            <ScrollArea className="flex-1">
              <div className="pt-0 px-3 pb-3 space-y-2">
                {/* Action Buttons */}
                <div className="flex flex-col gap-1">
                  <Button variant="ghost" className="w-full justify-start px-0 hover:bg-transparent h-8 py-1" onClick={() => console.log('Search')}>
                    <Search className="h-4 w-4 mr-2 text-muted-foreground" />
                    <span className="text-sm font-semibold text-foreground">Search</span>
                  </Button>
                  <Button variant="ghost" className="w-full justify-start px-0 hover:bg-transparent h-8 py-1" onClick={() => console.log('Library')}>
                    <Library className="h-4 w-4 mr-2 text-muted-foreground" />
                    <span className="text-sm font-semibold text-foreground">Library</span>
                  </Button>
                </div>
                <div className="my-1 h-px bg-border w-full" />
                <Collapsible open={isFilesOpen} onOpenChange={setIsFilesOpen}>
                  <CollapsibleTrigger className="w-full">
                    <div className="flex items-center gap-2 mb-2">
                      <FileText className="h-4 w-4 text-muted-foreground" />
                      <h2 className="text-sm font-semibold text-foreground">Files</h2>
                      <ChevronRight className={`h-4 w-4 text-muted-foreground transition-transform ${isFilesOpen ? 'rotate-90' : ''}`} />
                    </div>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    {isLoading ? (
                      <p className="text-sm text-muted-foreground py-4 text-center">Loading files...</p>
                    ) : files.length > 0 ? (
                      <div className="space-y-0.5">
                        {files.map((file) => {
                          const displayName = file.name.split('-').slice(1).join('-') || file.name;
                          return (
                            <Tooltip key={file.name}>
                              <TooltipTrigger asChild>
                                <button className="w-full relative flex items-center justify-between p-2.5 pr-14 rounded-lg hover:bg-secondary hover-lift group transition-all text-left">
                                  <div className="flex-1 min-w-0 flex items-center gap-2">
                                    <p className="text-sm font-medium text-foreground truncate">{displayName}</p>
                                    <Badge variant="secondary" className="text-xs px-1.5 py-0 flex-shrink-0">{getFileExtension(file.name)}</Badge>
                                  </div>
                                  <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                  <div className="absolute right-3 top-1/2 -translate-y-1/2 h-8 w-8 flex-shrink-0">
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      className="absolute inset-0 opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto transition-opacity"
                                      onClick={(e) => e.stopPropagation()}
                                    >
                                      <MoreHorizontal className="h-4 w-4" />
                                    </Button>
                                  </div>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end" side="top" className="z-[70]">
                                  <DropdownMenuItem onClick={() => handleDownloadFile(file.name)}>
                                    <Download className="mr-2 h-4 w-4" />
                                    Download
                                  </DropdownMenuItem>
                                  <DropdownMenuSeparator className="my-1 mx-2 h-[2px]" />
                                  <DropdownMenuItem 
                                    className="text-destructive"
                                    onClick={() => handleDeleteFile(file.name)}
                                  >
                                    <Trash2 className="mr-2 h-4 w-4" />
                                    Delete
                                  </DropdownMenuItem>
                                </DropdownMenuContent>
                                </DropdownMenu>
                              </button>
                            </TooltipTrigger>
                            <TooltipContent side="right" className="max-w-xs break-words">
                              {displayName}
                            </TooltipContent>
                          </Tooltip>
                          );
                        })}
                      </div>
                    ) : (
                      <p className="text-sm text-muted-foreground py-4 text-center">No files yet. Upload files to see them here.</p>
                    )}
                  </CollapsibleContent>
                </Collapsible>
              </div>
            </ScrollArea>

            {/* User Profile */}
            <div className="p-4">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button className="w-full flex items-center gap-3 p-2 rounded-lg hover:bg-secondary transition-colors">
                    <Avatar className="h-9 w-9">
                      <AvatarImage src="" alt="User" />
                      <AvatarFallback className="bg-primary text-primary-foreground">
                        <User className="h-5 w-5" />
                      </AvatarFallback>
                    </Avatar>
                    <div className="flex-1 text-left">
                      <p className="text-sm font-medium text-foreground">User Name</p>
                      <p className="text-xs text-muted-foreground">user@example.com</p>
                    </div>
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent side="top" align="center" sideOffset={8} className="z-[70] w-56 p-1">
                  <DropdownMenuLabel className="text-sm font-normal text-muted-foreground">user@example.com</DropdownMenuLabel>
                  <DropdownMenuItem>
                    <Crown className="mr-2 h-4 w-4 text-muted-foreground" />
                    Upgrade Plan
                  </DropdownMenuItem>
                  <DropdownMenuItem>
                    <ShoppingBag className="mr-2 h-4 w-4 text-muted-foreground" />
                    Orders
                  </DropdownMenuItem>
                  <DropdownMenuItem>
                    <Settings className="mr-2 h-4 w-4 text-muted-foreground" />
                    Settings
                  </DropdownMenuItem>
                  <div className="my-2 h-px bg-border w-full" />
                  <DropdownMenuItem className="justify-between">
                    <span className="flex items-center">
                      <HelpCircle className="mr-2 h-4 w-4 text-muted-foreground" />
                      Help
                    </span>
                    <ChevronRight className="h-4 w-4 opacity-70" />
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <aside
      className={`
        fixed top-0 left-0 bottom-0 z-[60] 
        bg-background border-r border-border shadow-none relative group
        transition-all duration-300 ease-out
        ${isCollapsed ? "w-12" : "w-64"}
      `}
      aria-label="Navigation drawer"
      id="stage-slideover-sidebar"
    >
      <div className="h-full flex flex-col">
        {/* Header */}
        <div className="h-14 flex items-center justify-between px-4">
          {!isCollapsed && (
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg overflow-hidden flex items-center justify-center">
                <img src={logo} alt="OverDrafter" className="w-full h-full object-contain" />
              </div>
              <span className="font-semibold text-foreground">OverDrafter</span>
            </div>
          )}
          {isCollapsed && (
            <button
              className="w-8 h-8 rounded-lg overflow-hidden flex items-center justify-center mx-auto hover:bg-secondary transition-colors"
              onClick={(e) => { e.stopPropagation(); onToggle(); }}
              onMouseEnter={() => setIsCollapsedHeaderHovered(true)}
              onMouseLeave={() => setIsCollapsedHeaderHovered(false)}
              aria-label="Expand sidebar"
            >
              {isCollapsedHeaderHovered ? (
                <PanelLeftOpen className="h-5 w-5 text-foreground" />
              ) : (
                <img src={logo} alt="OverDrafter" className="w-full h-full object-contain" />
              )}
            </button>
          )}
          {!isCollapsed && (
            <Button
              variant="ghost"
              size="icon"
              onClick={onToggle}
              className="hover:bg-secondary"
              aria-label="Collapse sidebar"
              aria-controls="stage-slideover-sidebar"
              aria-expanded={!isCollapsed}
            >
              <PanelLeftClose className="h-5 w-5" />
            </Button>
          )}
        </div>

        <TooltipProvider>
          <ScrollArea className="flex-1">
            <div className="pt-0 px-3 pb-3 space-y-2">
              {/* Action Buttons */}
              <div className="flex flex-col gap-1">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      className="w-full justify-start px-0 hover:bg-transparent h-8 py-1 relative"
                      onClick={(e) => { e.stopPropagation(); console.log('Search'); }}
                    >
                      <Search className="h-4 w-4 text-muted-foreground mr-2 flex-shrink-0" />
                      <span className={`text-sm font-semibold text-foreground transition-all duration-300 ${
                        isCollapsed 
                          ? 'opacity-0 w-0 overflow-hidden' 
                          : 'opacity-100'
                      }`}>
                        Search
                      </span>
                    </Button>
                  </TooltipTrigger>
                  {isCollapsed && <TooltipContent side="right">Search</TooltipContent>}
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      className="w-full justify-start px-0 hover:bg-transparent h-8 py-1 relative"
                      onClick={(e) => { e.stopPropagation(); console.log('Library'); }}
                    >
                      <Library className="h-4 w-4 text-muted-foreground mr-2 flex-shrink-0" />
                      <span className={`text-sm font-semibold text-foreground transition-all duration-300 ${
                        isCollapsed 
                          ? 'opacity-0 w-0 overflow-hidden' 
                          : 'opacity-100'
                      }`}>
                        Library
                      </span>
                    </Button>
                  </TooltipTrigger>
                  {isCollapsed && <TooltipContent side="right">Library</TooltipContent>}
                </Tooltip>
              </div>

              <div className={`my-1 h-px bg-border ${isCollapsed ? 'w-8 mx-auto' : 'w-full'}`} />

              {/* Files Section */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <div>
                    <Button
                      variant="ghost"
                      className="w-full justify-start px-0 hover:bg-transparent h-8 py-1 relative mb-2"
                      onClick={(e) => { 
                        e.stopPropagation(); 
                        if (!isCollapsed) {
                          setIsFilesOpen(!isFilesOpen);
                        }
                      }}
                    >
                      <FileText className="h-4 w-4 text-muted-foreground mr-2 flex-shrink-0" />
                      <span className={`text-sm font-semibold text-foreground transition-all duration-300 ${
                        isCollapsed 
                          ? 'opacity-0 w-0 overflow-hidden' 
                          : 'opacity-100'
                      }`}>
                        Files
                      </span>
                      <ChevronRight className={`h-4 w-4 text-muted-foreground transition-transform flex-shrink-0 ${
                        isCollapsed 
                          ? 'opacity-0 w-0 overflow-hidden' 
                          : isFilesOpen ? 'rotate-90' : ''
                      }`} />
                    </Button>
                    {!isCollapsed && (
                      <Collapsible open={isFilesOpen} onOpenChange={setIsFilesOpen}>
                        <CollapsibleContent>
                          {isLoading ? (
                            <p className="text-sm text-muted-foreground py-4 text-center">Loading files...</p>
                          ) : files.length > 0 ? (
                            <div className="space-y-0.5">
                              {files.map((file) => {
                                const displayName = file.name.split('-').slice(1).join('-') || file.name;
                                return (
                                  <Tooltip key={file.name}>
                                    <TooltipTrigger asChild>
                                      <button
                                        className="w-full relative flex items-center justify-between p-2.5 pr-12 rounded-lg hover:bg-secondary hover-lift group transition-all text-left"
                                      >
                                        <div className="flex-1 min-w-0 flex items-center gap-2">
                                          <p className="text-sm font-medium text-foreground truncate">
                                            {displayName}
                                          </p>
                                          <Badge
                                            variant="secondary"
                                            className="text-xs px-1.5 py-0 flex-shrink-0"
                                          >
                                            {getFileExtension(file.name)}
                                          </Badge>
                                        </div>
                                        <DropdownMenu>
                                      <DropdownMenuTrigger asChild>
                                        <div className="absolute right-2 top-1/2 -translate-y-1/2 h-8 w-8">
                                          <Button
                                            variant="ghost"
                                            size="icon"
                                            className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity focus-visible:ring-0 focus-visible:ring-offset-0"
                                            onClick={(e) => e.stopPropagation()}
                                          >
                                            <MoreHorizontal className="h-4 w-4" />
                                          </Button>
                                        </div>
                                      </DropdownMenuTrigger>
                                      <DropdownMenuContent align="end" side="top" className="z-[70]">
                                        <DropdownMenuItem onClick={() => handleDownloadFile(file.name)}>
                                          <Download className="mr-2 h-4 w-4" />
                                          Download
                                        </DropdownMenuItem>
                                        <DropdownMenuSeparator className="my-1 mx-2 h-[2px]" />
                                        <DropdownMenuItem 
                                          className="text-destructive"
                                          onClick={() => handleDeleteFile(file.name)}
                                        >
                                          <Trash2 className="mr-2 h-4 w-4" />
                                          Delete
                                        </DropdownMenuItem>
                                      </DropdownMenuContent>
                                        </DropdownMenu>
                                      </button>
                                    </TooltipTrigger>
                                    <TooltipContent side="right" className="max-w-xs break-words">
                                      {displayName}
                                    </TooltipContent>
                                  </Tooltip>
                                );
                              })}
                            </div>
                          ) : (
                            <p className="text-sm text-muted-foreground py-4 text-center">
                              No files yet. Upload files to see them here.
                            </p>
                          )}
                        </CollapsibleContent>
                      </Collapsible>
                    )}
                  </div>
                </TooltipTrigger>
                {isCollapsed && <TooltipContent side="right">Files</TooltipContent>}
              </Tooltip>
            </div>
          </ScrollArea>

          {/* User Profile */}
          <div className={isCollapsed ? "p-2" : "p-4"}>
            {!isCollapsed ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    className="w-full flex items-center gap-3 p-2 rounded-lg hover:bg-secondary transition-colors"
                  >
                    <Avatar className="h-9 w-9 flex-shrink-0">
                      <AvatarImage src="" alt="User" />
                      <AvatarFallback className="bg-primary text-primary-foreground">
                        <User className="h-5 w-5" />
                      </AvatarFallback>
                    </Avatar>
                    <div className="flex-1 text-left">
                      <p className="text-sm font-medium text-foreground">User Name</p>
                      <p className="text-xs text-muted-foreground">user@example.com</p>
                    </div>
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent side="top" align="center" sideOffset={8} className="z-[70] w-56 p-1">
                  <DropdownMenuLabel className="text-sm font-normal text-muted-foreground">
                    user@example.com
                  </DropdownMenuLabel>
                  <DropdownMenuItem>
                    <Crown className="mr-2 h-4 w-4 text-muted-foreground" />
                    Upgrade Plan
                  </DropdownMenuItem>
                  <DropdownMenuItem>
                    <ShoppingBag className="mr-2 h-4 w-4 text-muted-foreground" />
                    Orders
                  </DropdownMenuItem>
                  <DropdownMenuItem>
                    <Settings className="mr-2 h-4 w-4 text-muted-foreground" />
                    Settings
                  </DropdownMenuItem>
                  <div className="my-2 h-px bg-border w-full" />
                  <DropdownMenuItem className="justify-between">
                    <span className="flex items-center">
                      <HelpCircle className="mr-2 h-4 w-4 text-muted-foreground" />
                      Help
                    </span>
                    <ChevronRight className="h-4 w-4 opacity-70" />
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    className="w-full justify-start px-0 hover:bg-transparent h-8 py-1"
                    onClick={(e) => { e.stopPropagation(); console.log('User profile'); }}
                  >
                    <Avatar className="h-8 w-8 flex-shrink-0">
                      <AvatarImage src="" alt="User" />
                      <AvatarFallback className="bg-primary text-primary-foreground">
                        <User className="h-4 w-4" />
                      </AvatarFallback>
                    </Avatar>
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="right">User Profile</TooltipContent>
              </Tooltip>
            )}
          </div>
          
          {/* Hover open affordance */}
          {isCollapsed && (
            <div className="absolute inset-y-14 right-0 flex items-center justify-center pointer-events-none">
              <div className="w-5 h-10 -mr-2 rounded-l-full bg-muted/70 text-muted-foreground flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity duration-200">
                <ChevronRight className="h-4 w-4" />
              </div>
            </div>
          )}
        </TooltipProvider>
      </div>
    </aside>
  );
}
