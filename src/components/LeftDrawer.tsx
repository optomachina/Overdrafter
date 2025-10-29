import { X, FolderOpen, FileText, Plus, Upload, MoreVertical } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface LeftDrawerProps {
  isOpen: boolean;
  onClose: () => void;
}

const sampleProjects = [
  { id: 1, name: "Hydraulic Manifold Rev 3", timestamp: "2 hours ago" },
  { id: 2, name: "Gear Assembly Analysis", timestamp: "Yesterday" },
  { id: 3, name: "Bracket Optimization", timestamp: "3 days ago" },
];

const sampleFiles = [
  { id: 1, name: "manifold_body.STEP", type: "STEP", timestamp: "1 hour ago" },
  { id: 2, name: "assembly_drawing.PDF", type: "PDF", timestamp: "2 hours ago" },
  { id: 3, name: "gear_design.SLDPRT", type: "SLDPRT", timestamp: "Yesterday" },
  { id: 4, name: "dimensions.DXF", type: "DXF", timestamp: "2 days ago" },
];

export function LeftDrawer({ isOpen, onClose }: LeftDrawerProps) {
  return (
    <>
      {/* Overlay */}
      {isOpen && (
        <div
          className="fixed inset-0 bg-black/60 z-40 animate-fade-in"
          onClick={onClose}
          aria-hidden="true"
        />
      )}

      {/* Drawer */}
      <aside
        className={`
          fixed top-0 left-0 bottom-0 w-80 z-50 
          bg-card border-r border-border shadow-2xl
          transform transition-transform duration-300 ease-out
          ${isOpen ? "translate-x-0" : "-translate-x-full"}
        `}
        aria-label="Navigation drawer"
      >
        <div className="h-full flex flex-col">
          {/* Header */}
          <div className="h-16 flex items-center justify-between px-4 border-b border-border">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
                <span className="text-primary font-bold text-sm">OD</span>
              </div>
              <span className="font-semibold text-foreground">OverDrafter</span>
            </div>
            <Button
              variant="ghost"
              size="icon"
              onClick={onClose}
              className="hover:bg-secondary"
              aria-label="Close menu"
            >
              <X className="h-5 w-5" />
            </Button>
          </div>

          <ScrollArea className="flex-1">
            <div className="p-4 space-y-6">
              {/* Projects Section */}
              <section>
                <div className="flex items-center gap-2 mb-3">
                  <FolderOpen className="h-4 w-4 text-muted-foreground" />
                  <h2 className="text-sm font-semibold text-foreground">Projects</h2>
                </div>
                
                {sampleProjects.length > 0 ? (
                  <div className="space-y-1">
                    {sampleProjects.map((project) => (
                      <button
                        key={project.id}
                        className="w-full flex items-center justify-between p-3 rounded-lg hover:bg-secondary hover-lift group transition-all text-left"
                      >
                  <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-foreground truncate">
                            {project.name}
                          </p>
                          <p className="text-xs text-muted-foreground mt-0.5">
                            {project.timestamp}
                          </p>
                        </div>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 flex-shrink-0 ml-2"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <MoreVertical className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem>Draft</DropdownMenuItem>
                            <DropdownMenuItem>Design</DropdownMenuItem>
                            <DropdownMenuItem>Quote</DropdownMenuItem>
                            <DropdownMenuItem>Share</DropdownMenuItem>
                            <DropdownMenuItem>Rename</DropdownMenuItem>
                            <DropdownMenuItem>Archive</DropdownMenuItem>
                            <DropdownMenuItem className="text-destructive">Delete</DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground py-4 text-center">
                    No projects yet. Start by creating one.
                  </p>
                )}
              </section>

              {/* Files Section */}
              <section>
                <div className="flex items-center gap-2 mb-3">
                  <FileText className="h-4 w-4 text-muted-foreground" />
                  <h2 className="text-sm font-semibold text-foreground">Files</h2>
                </div>
                
                {sampleFiles.length > 0 ? (
                  <div className="space-y-1">
                    {sampleFiles.map((file) => (
                      <button
                        key={file.id}
                        className="w-full flex items-center justify-between p-3 rounded-lg hover:bg-secondary hover-lift group transition-all text-left"
                      >
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <p className="text-sm font-medium text-foreground truncate">
                              {file.name}
                            </p>
                            <Badge
                              variant="secondary"
                              className="text-xs px-1.5 py-0 flex-shrink-0"
                            >
                              {file.type}
                            </Badge>
                          </div>
                          <p className="text-xs text-muted-foreground mt-0.5">
                            {file.timestamp}
                          </p>
                        </div>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 flex-shrink-0 ml-2"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <MoreVertical className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem>Draft</DropdownMenuItem>
                            <DropdownMenuItem>Design</DropdownMenuItem>
                            <DropdownMenuItem>Quote</DropdownMenuItem>
                            <DropdownMenuItem>Share</DropdownMenuItem>
                            <DropdownMenuItem>Rename</DropdownMenuItem>
                            <DropdownMenuItem>Archive</DropdownMenuItem>
                            <DropdownMenuItem className="text-destructive">Delete</DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground py-4 text-center">
                    No files yet. Drag & drop or use the + button.
                  </p>
                )}
              </section>
            </div>
          </ScrollArea>

          {/* Footer Actions */}
          <div className="p-4 border-t border-border space-y-2">
            <Button
              variant="outline"
              className="w-full justify-start"
              onClick={() => console.log('New project')}
            >
              <Plus className="h-4 w-4 mr-2" />
              New Project
            </Button>
            <Button
              variant="outline"
              className="w-full justify-start"
              onClick={() => console.log('Upload files')}
            >
              <Upload className="h-4 w-4 mr-2" />
              Upload Files
            </Button>
          </div>
        </div>
      </aside>
    </>
  );
}
