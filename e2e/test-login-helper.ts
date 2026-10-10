/**
 * Test-only auth bypass helper for E2E tests.
 * 
 * This helper allows E2E tests to quickly authenticate as seeded test users
 * by calling the test-login Edge Function, which is only available in local
 * and preview environments (never in production).
 */

interface TestLoginOptions {
  email: string;
  redirectPath?: string;
  supabaseUrl?: string;
}

interface TestLoginResponse {
  actionLink: string;
  userId: string;
  redirectPath: string;
}

/**
 * Attempts to authenticate as a test user using the test-login Edge Function.
 * 
 * This will fail gracefully if:
 * - The test-login function is not available (production)
 * - The environment doesn't have ENABLE_TEST_LOGIN=1
 * - The Supabase URL is not localhost
 * - The current origin is not localhost
 * 
 * @param options - Test login options
 * @returns The action link to navigate to, or null if test login is not available
 */
export async function attemptTestLogin(options: TestLoginOptions): Promise<string | null> {
  const { email, redirectPath = "/", supabaseUrl } = options;
  const appOrigin = window.location.origin;

  try {
    const testLoginUrl = supabaseUrl
      ? `${supabaseUrl}/functions/v1/test-login`
      : `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/test-login`;

    const response = await fetch(testLoginUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email,
        redirectPath,
        appOrigin,
      }),
    });

    if (!response.ok) {
      console.warn("test-login not available:", response.status);
      return null;
    }

    const data = (await response.json()) as TestLoginResponse;
    return data.actionLink;
  } catch (error) {
    console.warn("test-login failed:", error);
    return null;
  }
}

/**
 * Checks if test login is available in the current environment.
 * 
 * @returns true if test login appears to be available
 */
export function isTestLoginAvailable(): boolean {
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
  const appOrigin = window.location.origin;

  try {
    const supabaseOrigin = new URL(supabaseUrl).origin;
    const isLocalhost =
      (appOrigin.includes("localhost") || appOrigin.includes("127.0.0.1")) &&
      (supabaseOrigin.includes("localhost") || supabaseOrigin.includes("127.0.0.1"));

    return isLocalhost;
  } catch {
    return false;
  }
}
