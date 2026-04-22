import { useState, useCallback } from "react";
import { loadStripe } from "@stripe/stripe-js";
import {
  Elements,
  CardElement,
  useStripe,
  useElements,
} from "@stripe/react-stripe-js";
import { Loader2, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";

const STRIPE_PUBLISHABLE_KEY = import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY as string;

type StripePaymentPanelProps = {
  projectId: string;
  amountLabel: string;
};

export function StripePaymentPanel({
  projectId,
  amountLabel,
}: StripePaymentPanelProps) {
  const [stripePromise] = useState(() => loadStripe(STRIPE_PUBLISHABLE_KEY));
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [isSettingUp, setIsSettingUp] = useState(false);
  const [paid, setPaid] = useState(false);

  const handleProceedToPayment = useCallback(async () => {
    setIsSettingUp(true);
    setSetupError(null);

    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const accessToken = sessionData.session?.access_token;

      if (!accessToken) {
        setSetupError("Your session has expired. Please sign in again.");
        return;
      }

      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/create-payment-intent`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`,
            apikey: import.meta.env.VITE_SUPABASE_ANON_KEY as string,
          },
          credentials: "include",
          body: JSON.stringify({ projectId }),
        },
      );

      const data = await response.json();

      if (!response.ok || !data.clientSecret) {
        setSetupError(data.error ?? "Payment setup failed. Try again or contact support.");
        return;
      }

      setClientSecret(data.clientSecret);
    } catch {
      setSetupError("Payment setup failed. Try again or contact support.");
    } finally {
      setIsSettingUp(false);
    }
  }, [projectId]);

  if (paid) {
    return (
      <section className="rounded-[26px] border border-emerald-500/30 bg-emerald-500/10 p-6">
        <div className="flex items-center gap-3">
          <CheckCircle2 className="h-6 w-6 shrink-0 text-emerald-400" />
          <div>
            <p className="text-lg font-semibold text-white">Payment confirmed</p>
            <p className="mt-1 text-sm text-white/60">
              Your payment of {amountLabel} was authorized. OverDrafter will place the order once the session is confirmed.
            </p>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="rounded-[26px] border border-white/8 bg-ws-card p-6">
      <p className="text-xs uppercase tracking-[0.18em] text-white/35">Payment</p>
      <h2 className="mt-2 text-xl font-semibold text-white">Proceed to payment</h2>
      <p className="mt-2 text-sm text-white/55">
        Authorize a card payment of <span className="text-white">{amountLabel}</span>. Your card will not be charged until OverDrafter confirms the Xometry order.
      </p>

      {!clientSecret ? (
        <div className="mt-6">
          {setupError ? (
            <div className="mb-4 rounded-2xl border border-rose-500/20 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
              {setupError}
            </div>
          ) : null}
          <Button
            type="button"
            className="rounded-full"
            disabled={isSettingUp}
            onClick={handleProceedToPayment}
          >
            {isSettingUp ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Setting up payment…
              </>
            ) : (
              "Proceed to payment"
            )}
          </Button>
        </div>
      ) : (
        <Elements stripe={stripePromise} options={{ clientSecret }}>
          <CardForm amountLabel={amountLabel} onSuccess={() => setPaid(true)} />
        </Elements>
      )}
    </section>
  );
}

type CardFormProps = {
  amountLabel: string;
  onSuccess: () => void;
};

function CardForm({ amountLabel, onSuccess }: CardFormProps) {
  const stripe = useStripe();
  const elements = useElements();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [cardError, setCardError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();

    if (!stripe || !elements) {
      return;
    }

    setIsSubmitting(true);
    setCardError(null);

    const cardElement = elements.getElement(CardElement);

    if (!cardElement) {
      setCardError("Card input not available. Please refresh and try again.");
      setIsSubmitting(false);
      return;
    }

    const { error, paymentIntent } = await stripe.confirmCardPayment(undefined as unknown as string, {
      payment_method: { card: cardElement },
    });

    if (error) {
      setCardError(error.message ?? "Payment failed. Please try again.");
      setIsSubmitting(false);
      return;
    }

    if (paymentIntent?.status === "requires_capture") {
      onSuccess();
    } else {
      setCardError("Unexpected payment status. Please contact support.");
    }

    setIsSubmitting(false);
  }

  return (
    <form onSubmit={handleSubmit} className="mt-6 space-y-4">
      <div
        className={cn(
          "rounded-2xl border border-white/10 bg-black/20 px-4 py-4",
        )}
      >
        <CardElement
          options={{
            style: {
              base: {
                color: "#ffffff",
                fontFamily: "inherit",
                fontSize: "14px",
                "::placeholder": { color: "rgba(255,255,255,0.35)" },
              },
              invalid: { color: "#fca5a5" },
            },
          }}
        />
      </div>

      {cardError ? (
        <div className="rounded-2xl border border-rose-500/20 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
          {cardError}
        </div>
      ) : null}

      <Button
        type="submit"
        className="w-full rounded-full"
        disabled={isSubmitting || !stripe}
      >
        {isSubmitting ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Authorizing…
          </>
        ) : (
          `Authorize ${amountLabel}`
        )}
      </Button>

      <p className="text-center text-xs text-white/35">
        Your card will only be charged after the Xometry order is confirmed.
      </p>
    </form>
  );
}
