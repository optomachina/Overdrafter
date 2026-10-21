import type { ElementHandle, Locator } from "playwright";

/** Candidates are evidence for manual cleanup, never authority to delete. */
export class CleanupRowsUnproven extends Error {
  constructor(readonly rows: Array<{ fileName: string | null }>) {
    super("manual_cleanup_required");
    this.name = "CleanupRowsUnproven";
  }
}

/** Freeze only a uniquely identified upload; DOM novelty alone proves nothing. */
export class UploadedPortalRows {
  private owned: ElementHandle<Node> | undefined;

  private constructor(
    private readonly rows: Locator,
    private readonly before: ElementHandle<Node>[],
    private readonly documentRoot: ElementHandle<Node>,
    private readonly stagedFileName: string,
    private readonly fileNameSelector?: string,
  ) {}

  static async snapshot(
    rows: Locator,
    root: Locator,
    stagedFileName: string,
    fileNameSelector?: string,
  ): Promise<UploadedPortalRows> {
    const documentRoot = await root.elementHandle();
    if (!documentRoot) throw new Error("CleanupDocumentMissing");
    return new UploadedPortalRows(rows, await rows.elementHandles(), documentRoot, stagedFileName, fileNameSelector);
  }

  private async fileName(row: ElementHandle<Node>): Promise<string | null> {
    if (!this.fileNameSelector) return null;
    const fields = await row.$$(this.fileNameSelector);
    if (fields.length !== 1) return null;
    // Compare the entire field. Trimming, dropping descendants, or stripping
    // apparent controls can turn an unrelated filename into a false match.
    // Mixed filename/control markup must be left for manual cleanup.
    return fields[0].evaluate((element) => element.textContent);
  }

  async targets(selector?: string, reportOnly = false): Promise<ElementHandle<Node>[]> {
    // A rerender/navigation destroys the baseline. Never treat replacement
    // customer rows as uploads; leave the cart for manual cleanup instead.
    for (const row of [this.documentRoot, ...this.before]) {
      if (!await row.evaluate((element) => element.isConnected)) {
        throw new Error("CleanupRowIdentityLost");
      }
    }
    const candidates: ElementHandle<Node>[] = [];
    for (const row of await this.rows.elementHandles()) {
      if (!await row.evaluate((element, before) => before.includes(element), this.before)) candidates.push(row);
    }
    const rows = await Promise.all(candidates.map(async (row) => ({ fileName: await this.fileName(row) })));
    // Report-only callers never adopt a row, even when its filename matches.
    if (reportOnly) {
      if (rows.length > 0) throw new CleanupRowsUnproven(rows);
      return [];
    }
    if (!this.owned) {
      // No upload-correlated provider identity is available. The only fallback
      // is ONE new row whose entire filename equals the bytes' staged name.
      if (candidates.length !== 1 || rows[0].fileName !== this.stagedFileName) throw new CleanupRowsUnproven(rows);
      this.owned = candidates[0];
    } else {
      // Recheck on every lookup, including after awaiting the kill switch.
      // Do not acquire a late arrival or a replacement of the original row.
      for (const row of candidates) {
        if (!await row.evaluate((element, owned) => owned.includes(element), [this.owned])) {
          throw new CleanupRowsUnproven(rows);
        }
      }
      if (candidates.length > 0 && rows[0].fileName !== this.stagedFileName) throw new CleanupRowsUnproven(rows);
    }
    if (!await this.owned.evaluate((element) => element.isConnected)) return [];
    if (candidates.length === 0) throw new CleanupRowsUnproven(rows);
    return selector ? this.owned.$$(selector) : [this.owned];
  }
}
