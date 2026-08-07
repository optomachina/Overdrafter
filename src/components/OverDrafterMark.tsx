import type { SVGProps } from "react";
import { cn } from "@/lib/utils";

/** Transparent, single-color OverDrafter mark for navigation chrome. */
export function OverDrafterMark({ className, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      {...props}
      data-overdrafter-mark
      viewBox="0 0 647 611"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      focusable="false"
      className={cn("text-current", className)}
    >
      <path
        d="M323.5 32L554 165.5V446L323.5 579L93 446V165.5L323.5 32Z"
        stroke="currentColor"
        strokeWidth="24"
        strokeLinejoin="round"
      />
      <path d="M323.5 32V579" stroke="currentColor" strokeWidth="24" strokeLinecap="round" />
      <path
        d="M93 165.5L323.5 305.5L554 165.5"
        stroke="currentColor"
        strokeWidth="24"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M93 446L323.5 305.5L554 446"
        stroke="currentColor"
        strokeWidth="24"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
