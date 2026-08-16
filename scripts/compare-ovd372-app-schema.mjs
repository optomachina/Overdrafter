import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function normalizeAppSchemaDump(contents) {
  return contents
    .replaceAll("\r\n", "\n")
    .split("\n")
    .filter(
      (line) => !line.startsWith("\\restrict ") && !line.startsWith("\\unrestrict "),
    )
    .join("\n");
}

export async function compareAppSchemaDumps(leftPath, rightPath) {
  const [leftContents, rightContents] = await Promise.all([
    readFile(leftPath, "utf8"),
    readFile(rightPath, "utf8"),
  ]);
  const left = normalizeAppSchemaDump(leftContents);
  const right = normalizeAppSchemaDump(rightContents);

  return {
    equal: left === right,
    leftSha256: sha256(left),
    rightSha256: sha256(right),
  };
}

async function main() {
  const [leftPath, rightPath] = process.argv.slice(2);
  if (!leftPath || !rightPath) {
    throw new Error(
      "Usage: node scripts/compare-ovd372-app-schema.mjs <upgraded.sql> <clean.sql>",
    );
  }

  const result = await compareAppSchemaDumps(leftPath, rightPath);
  if (!result.equal) {
    console.error("OVD-372 app-schema comparison failed.");
    console.error(`Left SHA-256: ${result.leftSha256}`);
    console.error(`Right SHA-256: ${result.rightSha256}`);
    process.exitCode = 1;
    return;
  }

  console.log(`OVD-372 app-schema comparison passed: ${result.leftSha256}`);
}

const isDirectExecution = process.argv[1]
  ? fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
  : false;

if (isDirectExecution) {
  await main();
}
