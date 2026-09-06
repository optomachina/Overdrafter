// @vitest-environment node

import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readWorkbookRows as readGenericRows } from "./importSpreadsheetQuotes";
import { readWorkbookRows as readDmriflesRows } from "./importDmriflesQuotes";

// Synthetic XLSX: shared strings, inline strings, a numeric quantity, and UTF-8.
// Contains no customer workbook content. ZIP entries use a fixed timestamp.
const WORKBOOK_BASE64 = "UEsDBBQAAAAIAAAAIVz0cxgMhAAAAKYAAAAPAAAAeGwvd29ya2Jvb2sueG1sNY7BCoNADER/ZckHNNpDD6JCoRePfsJWY3dxdyNJpP38SqmnmXnDwLRvlvXJvLpPTkUb6SCYbQ2iToGy1wtvVI5uYcnejigv5GWJEz142jMVw2tV3VAoeYtcNMRNoW81EJn+1RWfqYN7Sm7c2UjB/fgwd1CDkyYeRoa5BuxbPKd4fuu/UEsDBBQAAAAIAAAAIVzUxK1ZPwAAAFcAAAAaAAAAeGwvX3JlbHMvd29ya2Jvb2sueG1sLnJlbHOzCUrNSSzJzM8rzsgsKLazQeYqeKbYKhV5phgqKYQkFqWnltgqlecXZRdnpKaWFOuDKUO9itwcJX07G31UcwBQSwMEFAAAAAgAAAAhXMDlepwwAAAAQAAAABQAAAB4bC9zaGFyZWRTdHJpbmdzLnhtbLMpLi6xsynOtLMpsfPLL0ktttEH8vVBAhBBMwMzQwW1xNwCa4XkxLTDKxHy+iCtAFBLAwQUAAAACAAAACFccQJtE5IAAAA5AQAAGAAAAHhsL3dvcmtzaGVldHMvc2hlZXQxLnhtbHVQ2wrCMAz9ldF3SdvnLODtVZTtB+ooWNQN2rjh39utUodsTwnJuXFw6Pw93KxlwmkcDBtC3w2FL4UShM24bJUouBSufbjWVuzj3QVCprPxXJxez6v1CFEDxjM0X9pujXbh9wJ8n+AhwnqSCH36QUyTI+kcSa9o18eq3kiplvLoSVrprJ189cxX/fnCrBb4tfUBUEsBAhQDFAAAAAgAAAAhXPRzGAyEAAAApgAAAA8AAAAAAAAAAAAAAIABAAAAAHhsL3dvcmtib29rLnhtbFBLAQIUAxQAAAAIAAAAIVzUxK1ZPwAAAFcAAAAaAAAAAAAAAAAAAACAAbEAAAB4bC9fcmVscy93b3JrYm9vay54bWwucmVsc1BLAQIUAxQAAAAIAAAAIVzA5XqcMAAAAEAAAAAUAAAAAAAAAAAAAACAASgBAAB4bC9zaGFyZWRTdHJpbmdzLnhtbFBLAQIUAxQAAAAIAAAAIVxxAm0TkgAAADkBAAAYAAAAAAAAAAAAAACAAYoBAAB4bC93b3Jrc2hlZXRzL3NoZWV0MS54bWxQSwUGAAAAAAQABAANAQAAUgIAAAAA";
const workerDirectory = fileURLToPath(new URL("../../", import.meta.url));

// Keep adversarial parser checks outside Vitest's process and cap time, heap,
// and output so a future dependency regression cannot hang the test runner.
function runDependencyCheck(source: string): void {
  const result = spawnSync(process.execPath, ["--max-old-space-size=64", "--input-type=commonjs", "-e", source], {
    cwd: workerDirectory,
    timeout: 3_000,
    maxBuffer: 64 * 1024,
    encoding: "utf8",
  });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
}

describe("worker XML dependency security", () => {
  it("preserves synthetic workbook rows in both spreadsheet importers", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "xml-import-security-"));
    const workbookPath = path.join(directory, "synthetic.xlsx");
    try {
      await writeFile(workbookPath, Buffer.from(WORKBOOK_BASE64, "base64"));
      const expected = [{ "Part Number": "TEST-001", Qty: "12", Notes: "6061 & café" }];
      expect(await readGenericRows(workbookPath, "All Quotes")).toEqual(expected);
      expect(await readDmriflesRows(workbookPath, "All Quotes")).toEqual(expected);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects oversized entity expansion using the importers' parser options", () => {
    runDependencyCheck(`
      const assert = require("node:assert/strict");
      const { XMLParser } = require("fast-xml-parser");
      const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "" });
      const xml = '<!DOCTYPE r [<!ENTITY a "' + 'x'.repeat(1000) + '">]><r>' + '&a;'.repeat(101) + '</r>';
      assert.throws(() => parser.parse(xml), /Expanded content length limit exceeded/);
    `);
  });

  it("counts numeric and standard entities against explicit expansion limits", () => {
    // GHSA-8gc5-j5rx-235r: a tiny synthetic input is sufficient to detect
    // the bypass; the importers themselves keep htmlEntities at its default.
    runDependencyCheck(`
      const assert = require("node:assert/strict");
      const { XMLParser } = require("fast-xml-parser");
      for (const entity of ['&#65;', '&#x41;', '&amp;']) {
        const parser = new XMLParser({ htmlEntities: true, processEntities: { maxTotalExpansions: 10, maxExpandedLength: 100 } });
        assert.throws(() => parser.parse('<r>' + entity.repeat(11) + '</r>'), /Entity expansion count limit exceeded/);
      }
    `);
  });

  it("keeps quotes inside standalone builder attribute values with entity processing disabled", () => {
    // GHSA-5wm8-gmm8-39j9 concerns this transitive package. The importers
    // do not use a builder; this is not a guarantee about the parser's builder export.
    runDependencyCheck(`
      const assert = require("node:assert/strict");
      const XMLBuilder = require("fast-xml-builder").default;
      const { XMLParser } = require("fast-xml-parser");
      const value = '" extra="synthetic';
      const xml = new XMLBuilder({ ignoreAttributes: false, processEntities: false }).build({ a: { '@_attr': value } });
      assert.deepEqual(new XMLParser({ ignoreAttributes: false }).parse(xml), { a: { '@_attr': value } });
    `);
  });
});
