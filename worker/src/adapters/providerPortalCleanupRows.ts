import type { ElementHandle, Locator } from "playwright";

/** Exact DOM identities, never filename matches or positions in a changing cart. */
export class UploadedPortalRows {
  private owned: ElementHandle<Node>[] | undefined;

  private constructor(
    private readonly rows: Locator,
    private readonly before: ElementHandle<Node>[],
    private readonly documentRoot: ElementHandle<Node>,
  ) {}

  static async snapshot(rows: Locator, root: Locator): Promise<UploadedPortalRows> {
    const documentRoot = await root.elementHandle();
    if (!documentRoot) throw new Error("CleanupDocumentMissing");
    return new UploadedPortalRows(rows, await rows.elementHandles(), documentRoot);
  }

  async targets(selector?: string): Promise<ElementHandle<Node>[]> {
    // A rerender/navigation destroys the baseline. Never treat replacement
    // customer rows as uploads; leave the cart for manual cleanup instead.
    for (const row of [this.documentRoot, ...this.before]) {
      if (!await row.evaluate((element) => element.isConnected)) {
        throw new Error("CleanupRowIdentityLost");
      }
    }
    const current = await this.rows.elementHandles();
    if (!this.owned) {
      this.owned = [];
      for (const row of current) {
        if (!await row.evaluate((element, before) => before.includes(element), this.before)) {
          this.owned.push(row);
        }
      }
    }
    // A replacement row is indistinguishable from a concurrent addition.
    // Neither proves deletion; stop rather than report a false success.
    for (const row of current) {
      if (!await row.evaluate((element, known) => known.includes(element), [...this.before, ...this.owned])) {
        throw new Error("CleanupRowIdentityLost");
      }
    }
    const targets: ElementHandle<Node>[] = [];
    for (const row of this.owned) {
      if (await row.evaluate((element) => element.isConnected)) {
        targets.push(...(selector ? await row.$$(selector) : [row]));
      }
    }
    return targets;
  }
}
