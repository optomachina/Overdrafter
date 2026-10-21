// DESIGN.md: neutral surfaces; mono is reserved for short state labels.
export const STATUS_TONE = {
  text: "text-foreground",
  surface: "border-border bg-accent text-foreground",
  badge: "rounded-[2px] border border-border bg-accent font-sans text-foreground hover:bg-accent",
  state: "rounded-[2px] border border-border bg-accent font-mono text-foreground hover:bg-accent",
  callout: "rounded-[2px] border border-border bg-accent font-sans text-foreground",
  error: "bg-card font-sans text-destructive",
  action: "text-foreground focus:bg-accent focus:text-foreground",
} as const;
