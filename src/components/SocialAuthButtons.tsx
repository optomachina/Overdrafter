import { useState, type SVGProps } from "react";
import type { Provider } from "@supabase/supabase-js";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { buildAuthRedirectUrl } from "@/lib/auth-redirect";
import { cn } from "@/lib/utils";

type SocialAuthProviderId = Extract<Provider, "apple" | "azure" | "google">;

type SocialAuthProviderConfig = {
  id: SocialAuthProviderId;
  label: string;
  providerName: string;
  Icon: (props: SVGProps<SVGSVGElement>) => JSX.Element;
};

const SOCIAL_AUTH_PROVIDERS: SocialAuthProviderConfig[] = [
  {
    id: "google",
    label: "Google",
    providerName: "Google",
    Icon: GoogleIcon,
  },
  {
    id: "azure",
    label: "Microsoft",
    providerName: "Microsoft",
    Icon: MicrosoftIcon,
  },
  {
    id: "apple",
    label: "Apple",
    providerName: "Apple",
    Icon: AppleIcon,
  },
];

type SocialAuthButtonsProps = {
  buttonClassName?: string;
  className?: string;
  disabled?: boolean;
  redirectPath?: string;
};

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Authentication failed.";
}

export function SocialAuthButtons({
  buttonClassName,
  className,
  disabled = false,
  redirectPath = "/auth/callback",
}: SocialAuthButtonsProps) {
  const [pendingProvider, setPendingProvider] = useState<SocialAuthProviderId | null>(null);

  const handleSocialSignIn = async (provider: SocialAuthProviderConfig) => {
    setPendingProvider(provider.id);

    try {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: provider.id,
        options: {
          redirectTo: buildAuthRedirectUrl(redirectPath),
        },
      });

      if (error) {
        throw error;
      }
    } catch (error: unknown) {
      setPendingProvider(null);
      toast.error(getErrorMessage(error));
    }
  };

  return (
    <div className={cn("space-y-2", className)}>
      {SOCIAL_AUTH_PROVIDERS.map((provider) => {
        const isPending = pendingProvider === provider.id;

        return (
          <Button
            key={provider.id}
            type="button"
            variant="outline"
            className={cn("w-full justify-start", buttonClassName)}
            disabled={disabled || pendingProvider !== null}
            onClick={() => {
              void handleSocialSignIn(provider);
            }}
          >
            {isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <provider.Icon className="mr-2 h-4 w-4" />
            )}
            {isPending ? `Connecting to ${provider.providerName}` : `Continue with ${provider.label}`}
          </Button>
        );
      })}
    </div>
  );
}

function GoogleIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" {...props}>
      <path
        fill="currentColor"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
      />
      <path
        fill="currentColor"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
      />
      <path
        fill="currentColor"
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
      />
      <path
        fill="currentColor"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
      />
    </svg>
  );
}

function MicrosoftIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" {...props}>
      <path d="M11.4 24H0V12.6h11.4V24zM24 24H12.6V12.6H24V24zM11.4 11.4H0V0h11.4v11.4zm12.6 0H12.6V0H24v11.4z" />
    </svg>
  );
}

function AppleIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" {...props}>
      <path d="M17.05 20.28c-.98.95-2.05.8-3.08.35-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.35C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09l.01-.01zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z" />
    </svg>
  );
}
