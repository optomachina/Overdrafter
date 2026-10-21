import type { BrowserContext, ElementHandle, Locator, Page } from "playwright";

/** Extra evidence for script-created roots; CDP also covers parser-created roots. */
export async function trackCleanupShadowRoots(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const attachShadow = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (init) {
      const root = attachShadow.call(this, init);
      Object.defineProperty(this, "__ovdCleanupShadowRoot", { value: true });
      return root;
    };
  });
}

export class CleanupConfirmationUnproven extends Error {
  constructor(readonly lostPreUploadRows?: Array<{ fileName: string | null }>) {
    super("manual_cleanup_required");
    this.name = "CleanupConfirmationUnproven";
  }
}

/** Inspect before a click: parser-created roots bypass attachShadow tracking. */
export async function verifyCleanupShadowVisibility(context: BrowserContext, page: Page): Promise<void> {
  try {
    const session = await context.newCDPSession(page);
    try {
      const { root } = await session.send("DOM.getDocument", { depth: -1, pierce: true });
      const pending = [root];
      while (pending.length) {
        const node = pending.pop()!;
        // Inspect the whole pierced document, conservatively including both the
        // selected row's subtree and every ancestor (even a closed-root host).
        // Open roots are also unsafe: cleanup can remove hidden customer rows.
        // User-agent roots (e.g. native inputs) are not author-controlled cart DOM.
        if (node.shadowRootType === "open" || node.shadowRootType === "closed") {
          throw new CleanupConfirmationUnproven();
        }
        pending.push(...node.children ?? [], ...node.shadowRoots ?? []);
        if (node.contentDocument) pending.push(node.contentDocument);
        if (node.templateContent) pending.push(node.templateContent);
      }
    } finally {
      await session.detach();
    }
  } catch {
    // Missing/failed browser evidence is not permission to mutate the cart.
    throw new CleanupConfirmationUnproven();
  }
}

/** One cleanup pass can mutate only the row it first selected. */
export class CleanupRowConfirmation {
  private selected?: ElementHandle<Node>;
  private selectedFileName: string | null = null;
  private active?: { fileName: string | null; dialogSeen: boolean };

  private before?: Array<{ row: ElementHandle<Node>; fileName: string | null }>;
  private clicked = false;

  constructor(
    private readonly fileNameSelector?: string,
    private readonly rowSelector?: string,
    private readonly rows?: Locator,
    private readonly expectedFileName?: string,
    private readonly verifyShadowVisibility?: () => Promise<void>,
    private readonly page?: Page,
    private readonly preUploadRows?: ReadonlyArray<{ row: ElementHandle<Node>; fileName: string | null }>,
  ) {}

  async bind(row: ElementHandle<Node>): Promise<void> {
    const fileName = await this.fileName(row);
    if (!fileName || fileName !== this.expectedFileName || !this.rowSelector || !this.rows || !await row.evaluate((element, selected) => element.isConnected
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
    if (this.before) await this.verifyRows(false);
    // Include rows that arrived since an earlier, preparatory click as well.
    this.before = await this.snapshot();
    await this.verifyRows(false);
    await this.verifyStructure(row, target).catch(() => { throw new CleanupConfirmationUnproven(); });
    this.active = { fileName: this.selectedFileName, dialogSeen: false };
    try {
      // P3 residual risk: a re-render during the click can change this snapshot.
      await target.click();
      this.clicked = true;
    } finally {
      this.active = undefined;
      await this.verifyPreUploadRows();
    }
    await this.verifyStructure(row).catch(() => { throw new CleanupConfirmationUnproven(); });
    // A first click can open an in-row confirmation. It may leave our row in
    // place, but must never remove, replace, or rename any other row.
    await this.verifyRows(false);
  }

  /** The selected subtree must be isolated from every other cart identity. */
  private async verifyStructure(row: ElementHandle<Node>, target?: ElementHandle<Node>): Promise<void> {
    if (!this.page || !this.preUploadRows) throw new CleanupConfirmationUnproven();
    // Reject frame elements even before they acquire a document. Playwright's
    // frame inventory also covers owned frames that DOM queries cannot expose.
    if (!await row.evaluate((element) => !(element as Element).matches("iframe, frame, object, embed"))
      || (await row.$$("iframe, frame, object, embed")).length > 0) {
      throw new CleanupConfirmationUnproven();
    }
    for (const frame of this.page.frames()) {
      if (frame === this.page.mainFrame()) continue;
      const owner = await frame.frameElement();
      try {
        if (await owner.evaluate((element, selected) => {
          for (let node: Node | null = element; node; node = node.parentNode ?? (node as ShadowRoot).host ?? null) {
            if (node === selected) return true;
          }
          return false;
        }, row)) throw new CleanupConfirmationUnproven();
      } finally {
        await owner.dispose();
      }
    }
    // Resolve selectors with Playwright, never pass its selector language to CSS
    // APIs. Reject both nesting directions (including across open shadow roots):
    // removal deletes descendants and a click can bubble into an ancestor row.
    const current = await this.snapshot();
    if (!await row.evaluate((selected, { target, rows, before }) => {
      const contains = (parent: Node, child: Node): boolean => {
        for (let node: Node | null = child; node; ) {
          if (node === parent) return true;
          node = node.parentNode ?? (node as ShadowRoot).host ?? null;
        }
        return false;
      };
      return (!target || (selected.isConnected && target.isConnected && contains(selected, target) && rows.includes(selected)))
        && before.every((other) => !contains(selected, other) && !contains(other, selected))
        && rows.every((other) => other === selected
          || (!contains(selected, other) && !contains(other, selected)));
    }, { target, rows: [...this.before!, ...current].map(({ row }) => row), before: this.preUploadRows.map(({ row }) => row) })) {
      throw new CleanupConfirmationUnproven();
    }
    await this.verifyVisibleSubtree();
    // Pierce before and after mutation; report-only hooks never open CDP.
    if (!this.verifyShadowVisibility) throw new CleanupConfirmationUnproven();
    await this.verifyShadowVisibility();
  }

  private async verifyPreUploadRows(): Promise<void> {
    if (!this.page || !this.preUploadRows) throw new CleanupConfirmationUnproven();
    const lost: Array<{ fileName: string | null }> = [];
    for (const { row, fileName } of this.preUploadRows) {
      // isConnected alone remains true in the document of a removed iframe.
      const connected = await row.evaluate((element) => element.isConnected).catch(() => false);
      const frame = await row.ownerFrame().catch(() => null);
      if (!connected || !frame || !this.page.frames().includes(frame)) lost.push({ fileName });
    }
    if (lost.length) throw new CleanupConfirmationUnproven(lost);
  }

  private async verifyVisibleSubtree(): Promise<void> {
    // Refuse even empty roots, and hosts below the row, since a closed subtree
    // cannot establish absence of customer rows. Also check detached rows after
    // the click so an opaque subtree can never be reported as removed.
    if (!await this.selected!.evaluate((node) => {
      const element = node as Element;
      const ancestors: Element[] = [];
      for (let parent = element.parentElement; parent; parent = parent.parentElement) ancestors.push(parent);
      return [element, ...ancestors, ...element.querySelectorAll("*")].every((child) => !child.shadowRoot
        && !(child as Element & { __ovdCleanupShadowRoot?: boolean }).__ovdCleanupShadowRoot);
    })) throw new CleanupConfirmationUnproven();
  }

  private async snapshot() {
    return Promise.all((await this.rows!.elementHandles()).map(async (row) => ({
      row, fileName: await this.fileName(row),
    })));
  }

  private async verifyRows(requireRemoved: boolean): Promise<void> {
    await this.verifyPreUploadRows();
    await this.verifyVisibleSubtree();
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
    if (!active?.fileName || active.dialogSeen || type !== "confirm") throw new CleanupConfirmationUnproven();
    active.dialogSeen = true;
    // Native modals pause page JavaScript. Use the snapshot captured before
    // the active click; querying the DOM here can deadlock until timeout.
    // Exact single-row prompts only. Substring matching could approve a
    // different filename, a bulk deletion, or a message merely mentioning it.
    // A quoted spelling may itself be another row's literal filename. Do not
    // interpret that ambiguous prompt as permission to remove the bound row.
    const names = [active.fileName, `"${active.fileName}"`, `'${active.fileName}'`]
      .filter((name) => name === active.fileName || !this.before?.some(({ fileName }) => fileName === name));
    const prompts = names.flatMap((name) => [
      `Delete ${name}?`, `Remove ${name}?`,
      `Are you sure you want to delete ${name}?`,
      `Are you sure you want to remove ${name}?`,
    ]);
    if (!prompts.includes(message)) throw new CleanupConfirmationUnproven();
  }
}
