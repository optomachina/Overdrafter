import { getGeneratedPartInfo } from "@/features/generated-parts/generated-part-tags";

export function GeneratedPartBadge({ tags }: { tags: readonly string[] | null | undefined }) {
  const info = getGeneratedPartInfo(tags);
  if (!info) {
    return null;
  }
  return (
    <span
      data-testid="generated-part-badge"
      className="inline-flex items-center rounded-full border border-ws-border-subtle px-2 py-0.5 text-xs text-muted-foreground"
      title={info.generator ? `Created by ${info.generator}` : "Created by an agent"}
    >
      Generated{info.generator ? ` · ${info.generator}` : ""}
    </span>
  );
}
