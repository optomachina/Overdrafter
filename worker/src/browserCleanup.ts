import process from "node:process";

export const DEFAULT_BROWSER_CLEANUP_TIMEOUT_MS = 10_000;

export type FailClosedBrowserCleanupOptions = {
  cleanupTimeoutMs?: number;
  terminateProcess?: (message: string) => never;
};

function terminateCurrentProcess(message: string): never {
  console.error(message);
  process.exit(1);
}

class BrowserCleanupTimeoutError extends Error {}

/** Hard-stop the owning task rather than release credentials after wedged cleanup. */
export async function runFailClosedBrowserCleanup<T>(
  operation: () => Promise<T>,
  timeoutMessage: string,
  options: FailClosedBrowserCleanupOptions = {},
): Promise<T> {
  const timeoutMs =
    options.cleanupTimeoutMs ?? DEFAULT_BROWSER_CLEANUP_TIMEOUT_MS;
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new BrowserCleanupTimeoutError(timeoutMessage)),
          timeoutMs,
        );
      }),
    ]);
  } catch (error) {
    if (error instanceof BrowserCleanupTimeoutError) {
      const terminate = options.terminateProcess ?? terminateCurrentProcess;
      terminate(timeoutMessage);
      throw error;
    }
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
