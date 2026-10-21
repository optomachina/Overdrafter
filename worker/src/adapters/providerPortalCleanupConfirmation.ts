import type { ElementHandle, Locator } from "playwright";

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

  private before?: Array<{ row: ElementHandle<Node>; fileName: string | null }>;
  private clicked = false;

  constructor(
    private readonly fileNameSelector?: string,
    private readonly rowSelector?: string,
    private readonly rows?: Locator,
  ) {}

  async bind(row: ElementHandle<Node>): Promise<void> {
    const fileName = await this.fileName(row);
    if (!fileName || !this.rowSelector || !this.rows || !await row.evaluate((element, selected) => element.isConnected
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
    const rowSelector = this.rowSelector!;
    if (!await target.evaluate((element, { selected, rowSelector }) => selected.isConnected
      && element.isConnected && (element as Element).closest(rowSelector) === selected,
    { selected: row, rowSelector })) {
      throw new CleanupConfirmationUnproven();
    }
    if (this.before) await this.verifyRows(false);
    // Include rows that arrived since an earlier, preparatory click as well.
    this.before = await this.snapshot();
    await this.verifyRows(false);
    this.active = { fileName: this.selectedFileName };
    try {
      await target.click();
      this.clicked = true;
    } finally {
      this.active = undefined;
    }
    // A first click can open an in-row confirmation. It may leave our row in
    // place, but must never remove, replace, or rename any other row.
    await this.verifyRows(false);
  }

  private async snapshot() {
    return Promise.all((await this.rows!.elementHandles()).map(async (row) => ({
      row, fileName: await this.fileName(row),
    })));
  }

  private async verifyRows(requireRemoved: boolean): Promise<void> {
    const current = await this.snapshot();
    // An ambiguous field cannot prove that the selected filename is absent
    // (for example, a replacement row with duplicate filename fields).
    if (current.some(({ fileName }) => !fileName)) throw new CleanupConfirmationUnproven();
    const handles = current.map(({ row }) => row);
    const selectedPresent = await this.selected!.evaluate((element, rows) => rows.includes(element), handles);
    for (const previous of this.before!) {
      if (await previous.row.evaluate((element, selected) => element === selected[0], [this.selected!])) continue;
      if (!await previous.row.evaluate((element, rows) => element.isConnected && rows.includes(element), handles)
        || await this.fileName(previous.row) !== previous.fileName) throw new CleanupConfirmationUnproven();
    }
    const matchingNames = current.filter(({ fileName }) => fileName === this.selectedFileName);
    if (selectedPresent) {
      if (requireRemoved || matchingNames.length !== 1
        || await this.fileName(this.selected!) !== this.selectedFileName) throw new CleanupConfirmationUnproven();
    } else if (!this.clicked || matchingNames.length !== 0
      || await this.selected!.evaluate((element) => element.isConnected)) {
      throw new CleanupConfirmationUnproven();
    }
  }

  async verifiedRemoved(): Promise<number> {
    if (!this.clicked) return 0;
    await this.verifyRows(true);
    return 1;
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
