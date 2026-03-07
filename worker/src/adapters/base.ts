import type {
  VendorName,
  VendorQuoteAdapterInput,
  VendorQuoteAdapterOutput,
  WorkerConfig,
} from "../types.js";

export abstract class VendorAdapter {
  constructor(
    public readonly vendor: VendorName,
    protected readonly config: WorkerConfig,
  ) {}

  abstract quote(input: VendorQuoteAdapterInput): Promise<VendorQuoteAdapterOutput>;

  protected simulatedBaseAmount(input: VendorQuoteAdapterInput): number {
    const quantity = Math.max(1, input.requestedQuantity || input.requirement.quantity || input.part.quantity || 1);
    const toleranceMultiplier =
      input.requirement.tightest_tolerance_inch && input.requirement.tightest_tolerance_inch < 0.003
        ? 1.35
        : input.requirement.tightest_tolerance_inch && input.requirement.tightest_tolerance_inch < 0.005
          ? 1.15
          : 1;
    const materialMultiplier =
      /7075|stainless|17-4/i.test(input.requirement.material) ? 1.2 : /peek/i.test(input.requirement.material) ? 1.4 : 1;

    return Math.round((42 + quantity * 5) * toleranceMultiplier * materialMultiplier * 100) / 100;
  }
}
