import { X, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";

interface FileChipProps {
  fileName: string;
  onRemove: () => void;
}

export function FileChip({ fileName, onRemove }: FileChipProps) {
  const getFileExtension = (name: string) => {
    const parts = name.split('.');
    return parts.length > 1 ? parts[parts.length - 1].toUpperCase() : '';
  };

  return (
    <div className="inline-flex items-center gap-2 px-3 py-1.5 bg-secondary rounded-full border border-border hover-lift">
      <FileText className="h-3.5 w-3.5 text-muted-foreground" />
      <span className="text-sm text-foreground max-w-[200px] truncate">
        {fileName}
      </span>
      {getFileExtension(fileName) && (
        <span className="text-xs text-muted-foreground px-1.5 py-0.5 bg-muted rounded">
          {getFileExtension(fileName)}
        </span>
      )}
      <Button
        variant="ghost"
        size="icon"
        onClick={onRemove}
        className="h-5 w-5 p-0 hover:bg-destructive/20 hover:text-destructive rounded-full"
        aria-label={`Remove ${fileName}`}
      >
        <X className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}
