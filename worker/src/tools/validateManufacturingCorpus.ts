import { fileURLToPath, pathToFileURL } from "node:url";
import process from "node:process";
import {
  buildBlindedRunPlan,
  type BlindEvaluationPurpose,
  isCorpusContractError,
  serializeManufacturingBenchmark,
  validateManufacturingCorpus,
} from "../benchmarks/manufacturingCorpus.js";

type CliOptions = {
  manifestPath: string;
  externalRoots: Record<string, string>;
  strictCoverage: boolean;
  blindPlan: boolean;
  purpose: BlindEvaluationPurpose;
  processor: string;
};

const defaultManifestPath = fileURLToPath(
  new URL(
    "../../../benchmarks/manufacturing-characterization/manifest.v1.json",
    import.meta.url,
  ),
);

function usage() {
  return [
    "Usage: npm --prefix worker run corpus:validate -- [options]",
    "",
    "Options:",
    "  --manifest <path>     Corpus manifest (defaults to the checked-in v1 manifest)",
    "  --root <id>=<path>    Mount an external private corpus root; repeatable",
    "  --strict-coverage     Exit 1 while any process promotion target has a gap",
    "  --blind-plan          Emit eligible dependency inputs without annotations",
    "  --purpose <value>     local_parser_evaluation or geometry_sdk_evaluation",
    "  --processor <id>      Processor checked against each rights policy (default: local)",
    "  --help                Show this help",
  ].join("\n");
}

export function parseManufacturingCorpusCliArgs(argv: string[]): CliOptions {
  let manifestPath = defaultManifestPath;
  let strictCoverage = false;
  let blindPlan = false;
  let purpose: BlindEvaluationPurpose = "geometry_sdk_evaluation";
  let processor = "local";
  const externalRoots: Record<string, string> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--manifest") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--manifest requires a path");
      }
      manifestPath = value;
      index += 1;
      continue;
    }
    if (argument === "--root") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--root requires <id>=<path>");
      }
      const separatorIndex = value.indexOf("=");
      if (separatorIndex <= 0 || separatorIndex === value.length - 1) {
        throw new Error("--root requires <id>=<path>");
      }
      externalRoots[value.slice(0, separatorIndex)] = value.slice(
        separatorIndex + 1,
      );
      index += 1;
      continue;
    }
    if (argument === "--strict-coverage") {
      strictCoverage = true;
      continue;
    }
    if (argument === "--blind-plan") {
      blindPlan = true;
      continue;
    }
    if (argument === "--purpose") {
      const value = argv[index + 1];
      if (
        value !== "local_parser_evaluation" &&
        value !== "geometry_sdk_evaluation"
      ) {
        throw new Error(
          "--purpose requires local_parser_evaluation or geometry_sdk_evaluation",
        );
      }
      purpose = value;
      index += 1;
      continue;
    }
    if (argument === "--processor") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--processor requires an id");
      }
      processor = value;
      index += 1;
      continue;
    }
    if (argument === "--help") {
      throw new Error(usage());
    }

    throw new Error(`Unknown option: ${argument}`);
  }

  return {
    manifestPath,
    externalRoots,
    strictCoverage,
    blindPlan,
    purpose,
    processor,
  };
}

export async function runManufacturingCorpusCli(argv: string[]) {
  let options: CliOptions;
  try {
    options = parseManufacturingCorpusCliArgs(argv);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  try {
    if (options.blindPlan) {
      const plan = await buildBlindedRunPlan({
        manifestPath: options.manifestPath,
        externalRoots: options.externalRoots,
        purpose: options.purpose,
        processor: options.processor,
      });
      process.stdout.write(serializeManufacturingBenchmark(plan));
      return 0;
    }

    const report = await validateManufacturingCorpus({
      manifestPath: options.manifestPath,
      externalRoots: options.externalRoots,
    });
    process.stdout.write(serializeManufacturingBenchmark(report));

    if (!report.integrityPassed) {
      return 2;
    }
    if (
      options.strictCoverage &&
      report.coverage.some((cohort) => cohort.promotionBlocked)
    ) {
      return 1;
    }
    return 0;
  } catch (error) {
    if (isCorpusContractError(error)) {
      process.stderr.write(
        `${JSON.stringify(
          {
            error: error.message,
            diagnostics: error.diagnostics,
          },
          null,
          2,
        )}\n`,
      );
      return 2;
    }

    process.stderr.write(
      `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
    );
    return 2;
  }
}

const isDirectRun =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  process.exitCode = await runManufacturingCorpusCli(process.argv.slice(2));
}
