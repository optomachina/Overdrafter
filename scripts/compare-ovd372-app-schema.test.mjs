import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  compareAppSchemaDumps,
  normalizeAppSchemaDump,
} from "./compare-ovd372-app-schema.mjs";

describe("OVD-372 app-schema comparison", () => {
  it("ignores only pg_dump session restriction tokens and line endings", () => {
    const left = "header\r\n\\restrict first\r\ncreate table public.a();\r\n\\unrestrict first\r\n";
    const right = "header\n\\restrict second\ncreate table public.a();\n\\unrestrict second\n";

    expect(normalizeAppSchemaDump(left)).toBe(normalizeAppSchemaDump(right));
  });

  it("reports equal normalized app schemas", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ovd372-schema-equal-"));
    const leftPath = path.join(root, "upgraded.sql");
    const rightPath = path.join(root, "clean.sql");
    await writeFile(leftPath, "\\restrict first\ncreate table public.a();\n");
    await writeFile(rightPath, "\\restrict second\ncreate table public.a();\n");

    const result = await compareAppSchemaDumps(leftPath, rightPath);
    expect(result.equal).toBe(true);
    expect(result.leftSha256).toBe(result.rightSha256);
  });

  it("fails on an app-owned semantic difference", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ovd372-schema-drift-"));
    const leftPath = path.join(root, "upgraded.sql");
    const rightPath = path.join(root, "clean.sql");
    await writeFile(leftPath, "create table public.a(id uuid);\n");
    await writeFile(rightPath, "create table public.a(id text);\n");

    const result = await compareAppSchemaDumps(leftPath, rightPath);
    expect(result.equal).toBe(false);
    expect(result.leftSha256).not.toBe(result.rightSha256);
  });

  it("fails when otherwise identical app schemas differ only by a grant", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ovd372-schema-acl-drift-"));
    const leftPath = path.join(root, "upgraded.sql");
    const rightPath = path.join(root, "clean.sql");
    await writeFile(
      leftPath,
      "create function public.f() returns integer language sql as 'select 1';\ngrant execute on function public.f() to authenticated;\n",
    );
    await writeFile(
      rightPath,
      "create function public.f() returns integer language sql as 'select 1';\n",
    );

    const result = await compareAppSchemaDumps(leftPath, rightPath);
    expect(result.equal).toBe(false);
    expect(result.leftSha256).not.toBe(result.rightSha256);
  });
});
