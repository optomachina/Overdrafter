/**
 * Eval-facing view of the shared model cost table.
 *
 * The table lives in `../extraction/modelRegistry.ts` alongside provider
 * inference and capability flags, so production cost accounting and the eval
 * harness price a model the same way.
 */
export {
  estimateCost,
  MODEL_COSTS,
  type ModelCostEntry,
} from "../extraction/modelRegistry.js";
