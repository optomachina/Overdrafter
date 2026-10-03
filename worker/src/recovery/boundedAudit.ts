/** Audit delivery must never prevent cancellation or browser cleanup indefinitely. */
export async function recordBoundedAudit(write: () => Promise<void>): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(write).then(() => true, () => false),
      new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), 1_000); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}
