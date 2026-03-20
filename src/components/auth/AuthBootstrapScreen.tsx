import { Loader2 } from "lucide-react";

type AuthBootstrapScreenProps = {
  message?: string;
};

export function AuthBootstrapScreen({
  message = "Restoring your session.",
}: AuthBootstrapScreenProps) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-6">
      <div className="flex flex-col items-center gap-3 text-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        <p className="text-sm text-muted-foreground">{message}</p>
      </div>
    </div>
  );
}
