import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { QuotePresetMode, QuotePresetScope } from "@/features/quotes/selection";
import { cn } from "@/lib/utils";
import { Filter } from "lucide-react";

type QuoteSelectionFunctionBarProps = {
  scope: QuotePresetScope;
  mode: QuotePresetMode;
  requestedByDate: string | null;
  onScopeChange: (next: QuotePresetScope) => void;
  onModeChange: (next: QuotePresetMode) => void;
  onRequestedByDateChange: (next: string | null) => void;
  disabled?: boolean;
  dueDateHelpText?: string;
  matchingOptionCount?: number | null;
  totalOptionCount?: number;
  domesticAriaLabel?: string;
  globalAriaLabel?: string;
  className?: string;
};

function RoundUsaFlagIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden>
      <defs>
        <clipPath id="quote-selection-usa-flag-circle">
          <circle cx="16" cy="16" r="16" />
        </clipPath>
      </defs>
      <g clipPath="url(#quote-selection-usa-flag-circle)">
        <rect width="32" height="32" fill="#fff" />
        <rect y="0" width="32" height="2.46" fill="#b22234" />
        <rect y="4.92" width="32" height="2.46" fill="#b22234" />
        <rect y="9.84" width="32" height="2.46" fill="#b22234" />
        <rect y="14.76" width="32" height="2.46" fill="#b22234" />
        <rect y="19.68" width="32" height="2.46" fill="#b22234" />
        <rect y="24.6" width="32" height="2.46" fill="#b22234" />
        <rect y="29.52" width="32" height="2.48" fill="#b22234" />
        <rect width="17.1" height="17.22" fill="#3c3b6e" />
        <g fill="#fff">
          <circle cx="2.2" cy="2.2" r="0.8" />
          <circle cx="5.2" cy="2.2" r="0.8" />
          <circle cx="8.2" cy="2.2" r="0.8" />
          <circle cx="11.2" cy="2.2" r="0.8" />
          <circle cx="14.2" cy="2.2" r="0.8" />
          <circle cx="3.7" cy="4.5" r="0.8" />
          <circle cx="6.7" cy="4.5" r="0.8" />
          <circle cx="9.7" cy="4.5" r="0.8" />
          <circle cx="12.7" cy="4.5" r="0.8" />
          <circle cx="2.2" cy="6.8" r="0.8" />
          <circle cx="5.2" cy="6.8" r="0.8" />
          <circle cx="8.2" cy="6.8" r="0.8" />
          <circle cx="11.2" cy="6.8" r="0.8" />
          <circle cx="14.2" cy="6.8" r="0.8" />
          <circle cx="3.7" cy="9.1" r="0.8" />
          <circle cx="6.7" cy="9.1" r="0.8" />
          <circle cx="9.7" cy="9.1" r="0.8" />
          <circle cx="12.7" cy="9.1" r="0.8" />
          <circle cx="2.2" cy="11.4" r="0.8" />
          <circle cx="5.2" cy="11.4" r="0.8" />
          <circle cx="8.2" cy="11.4" r="0.8" />
          <circle cx="11.2" cy="11.4" r="0.8" />
          <circle cx="14.2" cy="11.4" r="0.8" />
          <circle cx="3.7" cy="13.7" r="0.8" />
          <circle cx="6.7" cy="13.7" r="0.8" />
          <circle cx="9.7" cy="13.7" r="0.8" />
          <circle cx="12.7" cy="13.7" r="0.8" />
        </g>
      </g>
    </svg>
  );
}

function RoundGlobeIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden>
      <circle cx="16" cy="16" r="16" fill="#0f172a" />
      <path
        d="M16 3.2c2.8 0 5.44.72 7.74 1.98A13.22 13.22 0 0 1 28.8 16c0 2.8-.88 5.4-2.38 7.54A13.25 13.25 0 0 1 16 28.8c-2.8 0-5.4-.88-7.54-2.38A13.25 13.25 0 0 1 3.2 16c0-2.8.88-5.4 2.38-7.54A13.25 13.25 0 0 1 16 3.2Z"
        fill="#1d4ed8"
      />
      <path
        d="M16 5.2c2.16 2.1 3.57 5.32 3.84 9.3h-7.68c.27-3.98 1.68-7.2 3.84-9.3Zm-4.01.97C10.2 8.3 9.07 11.2 8.83 14.5H5.47a10.57 10.57 0 0 1 6.52-8.33Zm8.02 0a10.57 10.57 0 0 1 6.52 8.33h-3.36c-.24-3.3-1.37-6.2-3.16-8.33ZM5.47 17.5h3.36c.24 3.3 1.37 6.2 3.16 8.33a10.57 10.57 0 0 1-6.52-8.33Zm7.01 0h7.04c-.26 3.56-1.47 6.52-3.52 8.42-2.05-1.9-3.26-4.86-3.52-8.42Zm10.69 0h3.36a10.57 10.57 0 0 1-6.52 8.33c1.79-2.13 2.92-5.03 3.16-8.33Z"
        fill="#bfdbfe"
      />
    </svg>
  );
}

export function QuoteSelectionFunctionBar({
  scope,
  mode,
  requestedByDate,
  onScopeChange,
  onModeChange,
  onRequestedByDateChange,
  disabled = false,
  dueDateHelpText = "Filters vendor options by the requested delivery date for this part.",
  matchingOptionCount = null,
  totalOptionCount = 0,
  domesticAriaLabel = "Using domestic quotes",
  globalAriaLabel = "Using global quotes",
  className,
}: QuoteSelectionFunctionBarProps) {
  const showDeadlineChip =
    Boolean(requestedByDate) &&
    typeof matchingOptionCount === "number" &&
    totalOptionCount > 0;

  return (
    <div className={cn("rounded-lg border border-ws-border-subtle bg-ws-card p-3", className)}>
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <TooltipProvider delayDuration={150}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={disabled}
                  className={cn(
                    "h-8 w-8 overflow-hidden rounded-full border border-white/10 p-0 [&_svg]:h-full [&_svg]:w-full",
                    scope === "domestic"
                      ? "border-white/20 bg-white text-black hover:bg-white/90"
                      : "bg-transparent text-white hover:bg-white/6",
                  )}
                  aria-label={scope === "domestic" ? domesticAriaLabel : globalAriaLabel}
                  aria-pressed={scope === "domestic"}
                  onClick={() => onScopeChange(scope === "domestic" ? "global" : "domestic")}
                >
                  {scope === "domestic" ? (
                    <RoundUsaFlagIcon className="h-full w-full" />
                  ) : (
                    <RoundGlobeIcon className="h-full w-full" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">
                {scope === "domestic" ? "Made in the USA" : "Sourced internationally"}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>

          <div
            className="inline-flex items-center overflow-hidden rounded-full border border-white/10 bg-black/20 p-0.5"
            role="group"
            aria-label="Quote preset"
          >
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={disabled}
              className={cn(
                "h-7 rounded-full px-3 text-xs",
                mode === "fastest"
                  ? "bg-white text-black hover:bg-white/90"
                  : "text-white hover:bg-white/6",
              )}
              aria-pressed={mode === "fastest"}
              onClick={() => onModeChange("fastest")}
            >
              Fast
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={disabled}
              className={cn(
                "h-7 rounded-full px-3 text-xs",
                mode === "cheapest"
                  ? "bg-white text-black hover:bg-white/90"
                  : "text-white hover:bg-white/6",
              )}
              aria-pressed={mode === "cheapest"}
              onClick={() => onModeChange("cheapest")}
            >
              Cheap
            </Button>
          </div>

          <div className="ml-auto flex items-center gap-2">
            <TooltipProvider delayDuration={150}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <label
                    className="inline-flex cursor-help items-center gap-1.5 text-[11px] font-medium text-white/55"
                    htmlFor="quote-selection-due-by"
                  >
                    <Filter className="h-3 w-3" aria-hidden />
                    Need by date
                  </label>
                </TooltipTrigger>
                <TooltipContent side="bottom">{dueDateHelpText}</TooltipContent>
              </Tooltip>
            </TooltipProvider>
            <div className="flex items-center gap-2">
              <Input
                id="quote-selection-due-by"
                type="date"
                value={requestedByDate ?? ""}
                disabled={disabled}
                onChange={(event) => onRequestedByDateChange(event.target.value || null)}
                aria-label="Need by date"
                className="h-8 w-[7.6rem] appearance-none rounded-full border-white/10 bg-white/[0.03] px-2 text-center text-sm text-white focus-visible:ring-white/20 [&::-webkit-calendar-picker-indicator]:cursor-pointer [&::-webkit-calendar-picker-indicator]:opacity-70 [&::-webkit-date-and-time-value]:text-center [&::-webkit-datetime-edit]:flex [&::-webkit-datetime-edit]:w-full [&::-webkit-datetime-edit]:items-center [&::-webkit-datetime-edit]:justify-center [&::-webkit-datetime-edit]:text-center [&::-webkit-datetime-edit-fields-wrapper]:flex [&::-webkit-datetime-edit-fields-wrapper]:w-full [&::-webkit-datetime-edit-fields-wrapper]:justify-center"
              />
              {requestedByDate ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={disabled}
                  className="h-8 rounded-full px-3 text-xs text-white/70 hover:bg-white/6 hover:text-white"
                  onClick={() => onRequestedByDateChange(null)}
                >
                  Clear
                </Button>
              ) : null}
            </div>
          </div>
        </div>
        {showDeadlineChip ? (
          <div className="flex justify-end">
            <div className="rounded-full border border-amber-400/20 bg-amber-500/10 px-3 py-1 text-xs text-amber-50/90">
              Showing {matchingOptionCount} of {totalOptionCount} options that meet your deadline.
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export type { QuoteSelectionFunctionBarProps };
