// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  createLocalPortalBrowserSession,
  localQuotePage,
  PRODUCTION_PORTAL_BROWSER_TIMEOUT_MS,
} from "../../test-support/localPortalBrowserFixture";
import { quickpartsDispatchAuthorization, quickpartsDispatchEnvelope } from "../../test-support/quickpartsDispatchFixture";
import { buildQuickpartsProductionPortalDefinition, QUICKPARTS_PRODUCTION_LOCATORS } from "./quickpartsPortal";

// Real Chromium, synthetic dispatch authorization and locally answered requests.
// The production Quickparts definition itself still has no cleanup hook.
const session = createLocalPortalBrowserSession({
  vendor: "quickparts",
  host: "quickquote.quickparts.com",
  pagePath: "/",
  cadBytes: "synthetic OVD-1022 cleanup regression bytes",
  cookieDomain: ".quickquote.quickparts.com",
  tempPrefix: "portal-cleanup-browser-",
  locators: QUICKPARTS_PRODUCTION_LOCATORS,
  buildDefinition: () => {
    const definition = buildQuickpartsProductionPortalDefinition();
    return {
      ...definition,
      selectors: { ...definition.selectors, cleanupRow: ".row", cleanupRowFileName: ":scope > .fname",
        cleanup: { removePart: { selector: ":scope > button.remove", scope: ".row" } } },
      hooks: { ...definition.hooks, cleanup: async (cleanup) => {
        await cleanup.click("removePart", "part.step");
        // Deliberately untrustworthy: DOM evidence must override these counts.
        return { removed: 1, remaining: 0 };
      } },
    };
  },
  bindAuthorization: (binding) => {
    const envelope = quickpartsDispatchEnvelope(binding);
    return { envelope, authorization: quickpartsDispatchAuthorization(envelope) };
  },
});

function row(name: string): string {
  return `<div class="row"><span class="fname">${name}</span><button class="remove">Remove</button></div>`;
}

function page(customerName: string, uploadName: string, captureRerender = false, nestCustomer = false): string {
  return localQuotePage({
    title: "QuickQuote",
    before: row(customerName),
    afterUpload: row(uploadName) + session.optionCard({
      id: "standard", label: "Standard", quantity: "3", unit: "10.00", total: "30.00", lead: "5",
    }),
    extraHead: `<script>
      document.addEventListener('click', (event) => {
        const button = event.target.closest('button.remove');
        if (!button) return;
        const selected = button.closest('.row');
        const name = selected.querySelector('.fname').textContent;
        fetch('/clicked?name=' + encodeURIComponent(name));
        if (confirm('Delete ' + name + '?')) {
          for (const removed of [selected, ...selected.querySelectorAll('.row')]) {
            fetch('/deleted?name=' + encodeURIComponent(removed.querySelector('.fname').textContent));
          }
          selected.remove();
        }
      });
      ${nestCustomer ? `new MutationObserver(() => {
        const rows = [...document.querySelectorAll('.row')];
        const uploaded = rows.find(row => row.querySelector('.fname').textContent === 'part.step');
        const customer = rows.find(row => row.querySelector('.fname').textContent === 'other.step');
        if (uploaded && customer && !uploaded.contains(customer)) uploaded.append(customer);
      }).observe(document.documentElement, { childList: true, subtree: true });` : ''}
      ${captureRerender ? `document.addEventListener('click', (event) => {
        if (!event.target.closest('button.remove')) return;
        const rows = [...document.querySelectorAll('.row')];
        // Model a capture-phase/index-keyed rerender: the old target is detached,
        // the wrong item disappears, and the selected filename survives.
        const replacement = rows.find(row => row.querySelector('.fname').textContent === 'part.step').cloneNode(true);
        rows.forEach(row => row.remove());
        document.querySelector('main').append(replacement);
      }, { capture: true, once: true });` : ''}
    </script>`,
  });
}

describe("row ownership and post-click evidence in Chromium (OVD-1022)", () => {
  it("never clicks the owned row when it contains a pre-existing customer row", async () => {
    const { output, error, observed } = await session.quoteAgainst(page("other.step", "part.step", false, true));
    expect(error).toBeNull();
    expect(observed.uploads).toHaveLength(1);
    expect(output?.rawPayload.cartCleanup).toMatchObject({
      status: "incomplete", removed: 0, reason: "manual_cleanup_required",
    });
    expect(observed.requests.filter((request) => /\/(clicked|deleted)\?/.test(request))).toEqual([]);
    session.expectOnlyProviderHost(observed);
  }, PRODUCTION_PORTAL_BROWSER_TIMEOUT_MS);

  it("never clicks the customer's part.step when upload creates part (1).step", async () => {
    const { output, error, observed } = await session.quoteAgainst(page("part.step", "part (1).step"));
    expect(error).toBeNull();
    expect(observed.uploads).toHaveLength(1);
    expect(output?.rawPayload.cartCleanup).toMatchObject({
      status: "incomplete", removed: 0, reason: "manual_cleanup_required",
      manualCleanupRows: [{ fileName: "part (1).step" }],
    });
    expect(observed.requests.filter((request) => /\/(clicked|deleted)\?/.test(request))).toEqual([]);
    session.expectOnlyProviderHost(observed);
  }, PRODUCTION_PORTAL_BROWSER_TIMEOUT_MS);

  it("removes only the uniquely owned row through its filename-bound native dialog", async () => {
    const { output, error, observed } = await session.quoteAgainst(page("other.step", "part.step"));
    expect(error).toBeNull();
    expect(output?.rawPayload.cartCleanup).toMatchObject({ status: "removed", removed: 1, remaining: 0 });
    expect(observed.requests.filter((request) => request.includes("/deleted?")))
      .toEqual(["GET https://quickquote.quickparts.com/deleted?name=part.step"]);
  }, PRODUCTION_PORTAL_BROWSER_TIMEOUT_MS);

  it("does not claim removal after a capture-phase rerender deletes the wrong row", async () => {
    const { output, error } = await session.quoteAgainst(page("other.step", "part.step", true));
    expect(error).toBeNull();
    expect(output?.rawPayload.cartCleanup).toMatchObject({
      status: "incomplete", removed: 0, reason: "manual_cleanup_required",
    });
  }, PRODUCTION_PORTAL_BROWSER_TIMEOUT_MS);
});
