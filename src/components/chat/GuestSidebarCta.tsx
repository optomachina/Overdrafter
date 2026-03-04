import { Button } from "@/components/ui/button";

type GuestSidebarCtaProps = {
  onLogIn: () => void;
};

export function GuestSidebarCta({ onLogIn }: GuestSidebarCtaProps) {
  return (
    <div className="space-y-4">
      <div>
        <p className="text-sm font-semibold text-white">Get quotes tailored to you</p>
        <p className="mt-3 text-sm leading-6 text-white/60">
          Log in to get quotes based on price and lead time, plus upload files.
        </p>
      </div>

      <Button
        type="button"
        variant="outline"
        className="h-11 w-full rounded-full border-white/10 bg-transparent text-white hover:bg-white/6"
        onClick={onLogIn}
      >
        Log in
      </Button>
    </div>
  );
}
