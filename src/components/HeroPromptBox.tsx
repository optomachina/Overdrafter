import { useState, useRef, ChangeEvent } from "react";
import { Plus, ArrowRight, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { toast } from "sonner";
import { FileChip } from "./FileChip";
import { supabase } from "@/integrations/supabase/client";
import { useQueryClient } from "@tanstack/react-query";

export function HeroPromptBox() {
  const [prompt, setPrompt] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const queryClient = useQueryClient();

  const allowedExtensions = [
    '.pdf', '.jpg', '.png', '.sldprt', '.asm', '.sldasm',
    '.prt', '.drw', '.slddrw', '.stp', '.igs', '.iges', '.step'
  ];

  const handleFileUpload = (e: ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = Array.from(e.target.files || []);
    const validFiles = selectedFiles.filter(file => {
      // Check file size
      const maxSize = 200 * 1024 * 1024; // 200MB
      if (file.size > maxSize) {
        toast.error(`${file.name} exceeds 200MB limit`);
        return false;
      }

      // Check file type
      const fileExtension = '.' + file.name.split('.').pop()?.toLowerCase();
      if (!allowedExtensions.includes(fileExtension)) {
        toast.error(`${file.name} has an unsupported file type`);
        return false;
      }

      return true;
    });

    setFiles(prev => [...prev, ...validFiles]);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const removeFile = (index: number) => {
    setFiles(prev => prev.filter((_, i) => i !== index));
  };

  const handleSubmit = async () => {
    if (!prompt.trim() && files.length === 0) {
      toast.error("Please enter a question or upload files");
      return;
    }

    setIsSubmitting(true);
    
    try {
      // Check if user is authenticated
      const { data: { user } } = await supabase.auth.getUser();
      
      if (!user) {
        toast.error("Please sign in to upload files");
        setIsSubmitting(false);
        return;
      }

      // Upload files to storage
      const uploadPromises = files.map(async (file) => {
        const fileName = `${user.id}/${Date.now()}-${file.name}`;
        
        const { error: uploadError } = await supabase.storage
          .from('uploads')
          .upload(fileName, file);

        if (uploadError) {
          throw uploadError;
        }

        return fileName;
      });

      await Promise.all(uploadPromises);
      
      toast.success("Files uploaded successfully!", {
        description: "Your files have been stored securely."
      });
      
      // Invalidate queries to refresh the file list in drawer
      queryClient.invalidateQueries({ queryKey: ['user-files'] });
      
      setPrompt("");
      setFiles([]);
    } catch (error) {
      console.error('Upload error:', error);
      toast.error("Failed to upload files. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const adjustTextareaHeight = () => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      const maxHeight = 3 * 24; // 3 lines * line-height
      textarea.style.height = Math.min(textarea.scrollHeight, maxHeight) + 'px';
    }
  };

  return (
    <section className="w-full max-w-4xl mx-auto px-4">
      <h1 className="text-4xl md:text-5xl font-semibold text-center mb-8 text-foreground">
        What shall we build today?
      </h1>

      <div className="space-y-3">
        {/* File chips display */}
        {files.length > 0 && (
          <div className="flex flex-wrap gap-2 px-4">
            {files.map((file, index) => (
              <FileChip
                key={`${file.name}-${index}`}
                fileName={file.name}
                onRemove={() => removeFile(index)}
              />
            ))}
          </div>
        )}

        {/* Main prompt input */}
        <div className="relative">
          <div className="flex items-end gap-2 p-2 bg-card border border-border rounded-full hover:border-primary/40 focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/20 transition-all">
            {/* Upload button */}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="flex-shrink-0 rounded-full hover:bg-secondary"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={isSubmitting}
                >
                  <Plus className="h-5 w-5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">Upload files</TooltipContent>
            </Tooltip>

            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept=".pdf,.jpg,.png,.sldprt,.asm,.sldasm,.prt,.drw,.slddrw,.stp,.igs,.iges,.step"
              onChange={handleFileUpload}
              className="hidden"
              aria-label="Upload files"
            />

            {/* Text input */}
            <textarea
              ref={textareaRef}
              value={prompt}
              onChange={(e) => {
                setPrompt(e.target.value);
                adjustTextareaHeight();
              }}
              onKeyDown={handleKeyDown}
              placeholder="Ask a question about your part, drawing, or design intent…"
              disabled={isSubmitting}
              rows={1}
              className="flex-1 bg-transparent border-none outline-none resize-none text-foreground placeholder:text-muted-foreground px-2 py-2 text-base disabled:opacity-70"
              style={{ minHeight: '24px', maxHeight: '72px' }}
            />

            {/* Submit button */}
            <Button
              onClick={handleSubmit}
              disabled={isSubmitting || (!prompt.trim() && files.length === 0)}
              className="flex-shrink-0 rounded-full bg-primary hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
              size="icon"
            >
              {isSubmitting ? (
                <Loader2 className="h-5 w-5 animate-spin-slow" />
              ) : (
                <ArrowRight className="h-5 w-5" />
              )}
            </Button>
          </div>
        </div>

      </div>
    </section>
  );
}
