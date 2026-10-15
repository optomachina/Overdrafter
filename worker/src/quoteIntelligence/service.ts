import { z } from "zod";
import { createDecisionSession } from "./decision.js";
import { quoteEvidenceInputSchema, selectQuoteEvidence } from "./quoteEvidence.js";
import { catalogInputSchema, matchCatalog } from "./catalog.js";
import { clarificationInputSchema, selectClarification } from "./clarification.js";
import { relevanceInputSchema, filterRelevantEvidence } from "./relevance.js";

export const reviewInputSchema = z.object({
  // This entry point intentionally rejects customer/vendor operational packets.
  dataClass: z.literal("synthetic"),
  request: z.object({ material: z.string().trim().min(1).max(120), process: z.string().trim().min(1).max(120),
    quantity: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), revision: z.string().trim().min(1).max(80),
    finish: z.string().trim().min(1).max(120),
  }).strict(),
  quote: quoteEvidenceInputSchema,
  catalog: catalogInputSchema,
  clarification: clarificationInputSchema,
  relevance: relevanceInputSchema,
}).strict().superRefine((input, ctx) => {
  if (input.quote.requestedQuantity !== input.request.quantity || input.quote.requestedRevision !== input.request.revision) {
    ctx.addIssue({ code: "custom", message: "Quote review scope differs from validated request" });
  }
  for (const key of ["material", "process", "quantity", "revision", "finish"] as const) {
    if (input.catalog.requested[key] !== input.request[key]) ctx.addIssue({ code: "custom", message: "Catalog review scope differs from validated request" });
  }
});
export type ReviewInput = z.input<typeof reviewInputSchema>;

/** Connected local review pipeline; validation precedes inference and nothing here can dispatch or publish. */
export async function reviewQuoteRequest(raw: unknown, options: Parameters<typeof createDecisionSession>[0] = {}) {
  const input = reviewInputSchema.parse(raw);
  const session = createDecisionSession(options);
  const facts = [...input.clarification.facts, ...(["material", "quantity", "revision", "finish"] as const)
    .map((field) => ({ field, values: [input.request[field]] }))];
  const clarification = await selectClarification({ ...input.clarification, facts }, session.decide);
  const quote = await selectQuoteEvidence(input.quote, session.decide);
  const catalog = await matchCatalog(input.catalog, session.decide);
  const relevance = await filterRelevantEvidence(input.relevance, session.decide);
  return { contract: "quote-intelligence-review.v1", localOnly: true, dispatchAllowed: false,
    publicationAllowed: false, quote, catalog, clarification, relevance, audit: session.audit };
}
