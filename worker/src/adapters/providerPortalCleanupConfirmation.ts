import type { ElementHandle } from "playwright";

export class CleanupConfirmationUnproven extends Error {
  constructor() {
    super("manual_cleanup_required");
    this.name = "CleanupConfirmationUnproven";
  }
}

/** One cleanup pass can mutate only the row it first selected. */
export class CleanupRowConfirmation {
  private selected?: ElementHandle<Node>;
  private selectedFileName: string | null = null;
  private active?: { fileName: string | null };

  constructor(private readonly fileNameSelector?: string) {}

  async bind(row: ElementHandle<Node>): Promise<void> {
    const fileName = await this.fileName(row);
    if (!await row.evaluate((element, selected) => element.isConnected
      && (selected.length === 0 || selected[0] === element), this.selected ? [this.selected] : [])
      || (this.selected && fileName !== this.selectedFileName)) {
      throw new CleanupConfirmationUnproven();
    }
    this.selected = row;
    this.selectedFileName = fileName;
  }

  private async fileName(row: ElementHandle<Node>): Promise<string | null> {
    if (!this.fileNameSelector) return null;
    const fields = await row.$$(this.fileNameSelector);
    return fields.length === 1 ? fields[0].evaluate((element) => element.textContent) : null;
  }

  async click(row: ElementHandle<Node>, target: ElementHandle<Node>): Promise<void> {
    await this.bind(row);
    if (!await target.evaluate((element, rows) => rows[0].isConnected
      && element.isConnected && rows[0].contains(element), [row])) {
      throw new CleanupConfirmationUnproven();
    }
    this.active = { fileName: this.selectedFileName };
    try {
      await target.click();
    } finally {
      this.active = undefined;
    }
  }

  assertNativeDialog(type: string, message: string): void {
    const active = this.active;
    if (!active?.fileName || type !== "confirm") throw new CleanupConfirmationUnproven();
    // Native modals pause page JavaScript. Use the snapshot captured before
    // the active click; querying the DOM here can deadlock until timeout.
    // Exact single-row prompts only. Substring matching could approve a
    // different filename, a bulk deletion, or a message merely mentioning it.
    const names = [active.fileName, `"${active.fileName}"`, `'${active.fileName}'`];
    const prompts = names.flatMap((name) => [
      `Delete ${name}?`, `Remove ${name}?`,
      `Are you sure you want to delete ${name}?`,
      `Are you sure you want to remove ${name}?`,
    ]);
    if (!prompts.includes(message)) throw new CleanupConfirmationUnproven();
  }
}
