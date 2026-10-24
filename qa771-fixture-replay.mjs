import { createRequire } from "module";
// Use vitest/tsx path via dynamic import of compiled-through-tsx
import { register } from "node:module";
import { pathToFileURL } from "node:url";

async function main() {
  const { collectXometryOffers } = await import("./worker/src/adapters/xometryOffers.ts");
  const { XOMETRY_LOCATORS } = await import("./worker/src/adapters/xometryConstraints.ts");

  function quotePage(texts, tierText = "Standard") {
    const options = texts.map((text, index) => ({
      innerText: async () => text,
      getAttribute: async (name) => (name === "data-option-id" ? `option-${index}` : null),
      locator: (selector) =>
        selector.includes("disabled")
          ? { count: async () => 0 }
          : { first: () => ({ innerText: async () => tierText }) },
    }));
    return {
      url: () => "https://www.xometry.com/quoting/quote/Q26-SYNTHETIC",
      locator: (selector) => ({
        count: async () => (selector === XOMETRY_LOCATORS.offerContainers[0] ? options.length : 0),
        nth: (index) => options[index],
      }),
    };
  }

  const text =
    "Standard\nUSD $20.00 ea.\nUSD $40.00\n5 business days\nQuantity: 2\nRevision: B\nThis is not a firm quote";
  const source = `${text}\n${"local evidence ".repeat(120)}\nRevision: C`;
  const alt = text.replace("$20.00 ea.\nUSD $40.00", "$30.00 ea.\nUSD $60.00");

  const f1 = await collectXometryOffers(quotePage([source, alt]), 2);
  console.log("FIXTURE1_QTY", 2);
  console.log("FIXTURE1_SOURCE_SNIPPET", JSON.stringify(source.split("\n").slice(0, 4)));
  console.log("FIXTURE1_ALT_SNIPPET", JSON.stringify(alt.split("\n").slice(0, 4)));
  console.log(
    "FIXTURE1_OFFERS",
    JSON.stringify(
      f1.map((o) => ({
        unitPriceUsd: o.unitPriceUsd,
        totalPriceUsd: o.totalPriceUsd,
        quantity: o.quantity,
        leadTimeDays: o.leadTimeDays,
      })),
      null,
      2,
    ),
  );
  console.log(
    "FIXTURE1_MATH_OK",
    f1.every((o) => Math.abs(o.unitPriceUsd * 2 - o.totalPriceUsd) < 0.015),
  );

  const f2text = "Standard\nUSD $5.00 ea.\nUSD $35.00\n5 business days";
  const f2 = await collectXometryOffers(quotePage([f2text]), 7);
  console.log("FIXTURE2_QTY", 7);
  console.log("FIXTURE2_SOURCE", JSON.stringify(f2text));
  console.log(
    "FIXTURE2_OFFERS",
    JSON.stringify(
      f2.map((o) => ({
        unitPriceUsd: o.unitPriceUsd,
        totalPriceUsd: o.totalPriceUsd,
        quantity: o.quantity,
      })),
      null,
      2,
    ),
  );
  console.log(
    "FIXTURE2_MATH_OK",
    f2.every((o) => Math.abs(o.unitPriceUsd * 7 - o.totalPriceUsd) < 0.015),
  );

  try {
    await collectXometryOffers(quotePage(["Standard\nUSD $40.00\n5 business days"]), 7);
    console.log("OLD_LONE_TOTAL_QTY7_UNEXPECTED_PASS");
  } catch (e) {
    console.log("OLD_LONE_TOTAL_QTY7_REFUSED", e?.payload?.reason || e?.message);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
