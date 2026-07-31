import { createMobileAuthHandler } from "../server/mobile-auth/handler";
import { loadMobileAuthRuntimeConfig } from "../server/mobile-auth/runtime-config";
import { createSupabaseMobileAuthRepository } from "../server/mobile-auth/supabase-repository";
import { createTransferSessionVerifier } from "../server/mobile-auth/supabase-transfer";

type MobileAuthHandler = (request: Request) => Promise<Response>;

let resolvedHandler: MobileAuthHandler | null = null;

function serviceUnavailableResponse(): Response {
  return new Response(
    "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Sign in unavailable</title></head><body><main><h1>Sign in is temporarily unavailable</h1><p>Return to OverDrafter and try again later.</p></main></body></html>",
    {
      status: 503,
      headers: {
        "Cache-Control": "no-store, max-age=0",
        Pragma: "no-cache",
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy":
          "default-src 'none'; script-src 'none'; style-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; img-src 'none'; object-src 'none';",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
      },
    },
  );
}

function getHandler(): MobileAuthHandler {
  if (resolvedHandler) {
    return resolvedHandler;
  }

  const config = loadMobileAuthRuntimeConfig(process.env);
  const repository = createSupabaseMobileAuthRepository(
    config.supabaseOrigin,
    config.supabaseServiceRoleKey,
  );
  const transferVerifier = createTransferSessionVerifier(
    config.supabaseOrigin,
    config.supabasePublishableKey,
  );
  resolvedHandler = createMobileAuthHandler({
    config,
    repository,
    transferVerifier,
  });
  return resolvedHandler;
}

async function mobileAuth(request: Request): Promise<Response> {
  try {
    return await getHandler()(request);
  } catch {
    console.error("mobile-auth: request handling failed");
    return serviceUnavailableResponse();
  }
}

export default {
  fetch: mobileAuth,
};
