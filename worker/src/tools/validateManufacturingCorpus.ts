import { runValidateManufacturingCorpusCli } from "./validateManufacturingCorpusCli.js";

const result = await runValidateManufacturingCorpusCli(
  process.argv.slice(2),
);

if (result.stdout.length > 0) {
  process.stdout.write(result.stdout);
}
if (result.stderr.length > 0) {
  process.stderr.write(result.stderr);
}
process.exitCode = result.exitCode;
