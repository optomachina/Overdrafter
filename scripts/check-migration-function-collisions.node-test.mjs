/** Offline function collision messages only. Reads SQL text; never applies or rewrites migrations. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  SUPERSESSIONS_FILE,
  findFunctionCollisions,
  inspectFunctionCollisions,
  parseSupersessions,
  scanFunctionEvents,
} from "./check-migration-function-collisions.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "check-migration-function-collisions.mjs");
const S4 = "public.api_authorize_worker_dispatch(uuid,uuid,jsonb,text,timestamptz)";
const S4_HEAD = "public.api_authorize_worker_dispatch(p_task uuid, p_lane uuid, p_payload jsonb, p_reason text, p_now timestamptz)";

const md5 = (text) => createHash("md5").update(text, "utf8").digest("hex");

/** A create or replace function statement whose stored body is exactly `body`. */
function fn(head, body, tag = "$$") {
  return `create or replace function ${head}\nreturns boolean\nlanguage plpgsql\nsecurity definer\nset search_path = pg_catalog\nas ${tag}${body}${tag};\n`;
}

const MIGRATIONS = "supabase/migrations";
const DRAFTS = "docs/migration-drafts";

function makeTree(files) {
  const root = mkdtempSync(join(tmpdir(), "fn-collisions-"));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), text);
  }
  return root;
}

function allowlist(...entries) {
  return JSON.stringify({
    version: 1,
    supersessions: entries.map(([signature, file, supersedesMd5]) => ({
      signature,
      file,
      supersedesMd5,
      reason: "Written against that body; the draft is rebased before promotion.",
    })),
  });
}

const BODY_V1 = "\nbegin\n  return p_lane is not null;\nend;\n";
const BODY_V2 = "\nbegin\n  return p_lane is not null and p_reason is not null;\nend;\n";
const BODY_DRAFT = "\nbegin\n  return p_lane is not null and p_now is not null;\nend;\n";

const migrationV1 = `${MIGRATIONS}/20261002182910_s4_original.sql`;
const migrationV2 = `${MIGRATIONS}/20261020100000_s4_quantity.sql`;
const draftS4 = `${DRAFTS}/ovd-762-fanout.sql`;

// ---- scanning ---------------------------------------------------------------

test("a body hashes to md5(pg_proc.prosrc): the exact text between the dollar quotes", () => {
  const [event] = scanFunctionEvents(fn(S4_HEAD, BODY_V1));
  assert.equal(event.signature, S4);
  assert.equal(event.bodyMd5, md5(BODY_V1));
  assert.equal(event.bodyBytes, Buffer.byteLength(BODY_V1, "utf8"));
  assert.equal(event.action, "define");
});

test("argument names, modes, defaults and type spellings reduce to one canonical signature", () => {
  const sql = fn(
    `Private."Do_It"(IN p_a int, OUT p_ignored text, p_b public.vendor_name[] default '{}', variadic p_c text[], p_d timestamp with time zone = now(), p_e double precision, p_f numeric(10, 2), p_g bool, p_h character varying(20))`,
    "x",
  );
  const [event] = scanFunctionEvents(sql);
  assert.equal(
    event.signature,
    "private.Do_It(integer,vendor_name[],text[],timestamptz,double precision,numeric,boolean,character varying)",
  );
});

test("an unqualified name is a public function and unnamed arguments keep their types", () => {
  const [event] = scanFunctionEvents(fn("plain_fn(uuid, text[], int8)", "x"));
  assert.equal(event.signature, "public.plain_fn(uuid,text[],bigint)");
});

test("overloads with different argument types are different functions", () => {
  const events = scanFunctionEvents(fn("public.f(uuid)", "x") + fn("public.f(uuid, text)", "x"));
  assert.deepEqual(events.map((event) => event.signature), ["public.f(uuid)", "public.f(uuid,text)"]);
});

test("comments, strings and bodies never produce a definition", () => {
  const sql = [
    "-- create or replace function public.in_line_comment() returns int as $$ x $$;",
    "/* create function public.in_block_comment() returns int as $$ x $$; /* nested */ still a comment */",
    "select 'create function public.in_string() returns int as $$ x $$;';",
    "select E'it\\'s create function public.in_escape_string()';",
    'do $do$ begin execute $q$create function public.in_do_block() returns int as $b$ x $b$$q$; end $do$;',
    fn("public.real_one()", "select 1;", "$body$"),
  ].join("\n");
  assert.deepEqual(scanFunctionEvents(sql).map((event) => event.signature), ["public.real_one()"]);
});

test("a dollar quoted body may contain other dollar quotes and semicolons", () => {
  const body = "\nbegin\n  perform $inner$ a; b; $inner$;\nend;\n";
  const [event] = scanFunctionEvents(fn("public.outer_fn()", body, "$outer$"));
  assert.equal(event.bodyMd5, md5(body));
});

test("a single quoted body unescapes doubled quotes", () => {
  const sql = "create function public.quoted() returns text language sql as 'select ''hi'';';";
  const [event] = scanFunctionEvents(sql);
  assert.equal(event.bodyMd5, md5("select 'hi';"));
});

test("create, replace and drop are reported in source order with line numbers", () => {
  const sql = `${fn("public.a()", "1")}\ndrop function if exists public.a(), public.b(uuid);\n${fn("public.a()", "2")}`;
  const events = scanFunctionEvents(sql);
  assert.deepEqual(events.map((event) => [event.action, event.signature]), [
    ["define", "public.a()"],
    ["drop", "public.a()"],
    ["drop", "public.b(uuid)"],
    ["define", "public.a()"],
  ]);
  assert.equal(events[0].line, 1);
  assert.ok(events[3].line > events[1].line);
});

test("a function without a readable AS body is reported as unreadable, not skipped", () => {
  const sql = "create function public.atomic_body(p int) returns int language sql begin atomic select p; end;";
  const [event] = scanFunctionEvents(sql);
  assert.equal(event.bodyMd5, null);
  const violations = findFunctionCollisions([{ ...event, file: `${MIGRATIONS}/20260101000000_x.sql`, kind: "migration" }]);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /public\.atomic_body\(integer\) has no body this check can read/);
});

// ---- decisions on whole trees -----------------------------------------------

test("migrations that restate each other are history, not a collision", () => {
  const root = makeTree({
    [migrationV1]: fn(S4_HEAD, BODY_V1),
    [migrationV2]: fn(S4_HEAD, BODY_V2),
  });
  assert.deepEqual(inspectFunctionCollisions(root), []);
});

test("a draft restating the deployed function with a different body fails and prints the entry to add", () => {
  const root = makeTree({
    [migrationV1]: fn(S4_HEAD, BODY_V1),
    [draftS4]: fn(S4_HEAD, BODY_DRAFT),
  });
  const violations = inspectFunctionCollisions(root);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /^public\.api_authorize_worker_dispatch\(uuid,uuid,jsonb,text,timestamptz\): docs\/migration-drafts\/ovd-762-fanout\.sql/);
  assert.ok(violations[0].includes(`(md5 ${md5(BODY_DRAFT)}) would replace the deployed body from ${migrationV1} (md5 ${md5(BODY_V1)})`));
  assert.ok(violations[0].includes(`"supersedesMd5":"${md5(BODY_V1)}"`));
  assert.ok(violations[0].includes(SUPERSESSIONS_FILE));
});

test("naming the superseded md5 in the allowlist clears the draft", () => {
  const root = makeTree({
    [migrationV1]: fn(S4_HEAD, BODY_V1),
    [draftS4]: fn(S4_HEAD, BODY_DRAFT),
    [SUPERSESSIONS_FILE]: allowlist([S4, draftS4, md5(BODY_V1)]),
  });
  assert.deepEqual(inspectFunctionCollisions(root), []);
});

test("OVD-762 against OVD-987: a newer migration body makes the old entry stale and fails until the draft is rebased", () => {
  const files = {
    [migrationV1]: fn(S4_HEAD, BODY_V1),
    [draftS4]: fn(S4_HEAD, BODY_DRAFT),
    [SUPERSESSIONS_FILE]: allowlist([S4, draftS4, md5(BODY_V1)]),
  };
  assert.deepEqual(inspectFunctionCollisions(makeTree(files)), []);

  const quantityLands = makeTree({ ...files, [migrationV2]: fn(S4_HEAD, BODY_V2) });
  const violations = inspectFunctionCollisions(quantityLands);
  assert.equal(violations.length, 2);
  assert.ok(violations.some((line) => line.includes(`would replace the deployed body from ${migrationV2} (md5 ${md5(BODY_V2)})`)));
  assert.ok(violations.some((line) => line.includes(`unused entry for ${S4} in ${draftS4} naming md5 ${md5(BODY_V1)}`)));

  const rebased = makeTree({
    ...files,
    [migrationV2]: fn(S4_HEAD, BODY_V2),
    [SUPERSESSIONS_FILE]: allowlist([S4, draftS4, md5(BODY_V2)]),
  });
  assert.deepEqual(inspectFunctionCollisions(rebased), []);
});

test("a draft that equals the deployed body, or any earlier migration body, is an archived copy", () => {
  const root = makeTree({
    [migrationV1]: fn(S4_HEAD, BODY_V1),
    [migrationV2]: fn(S4_HEAD, BODY_V2),
    [`${DRAFTS}/promoted-copy.sql`]: fn(S4_HEAD, BODY_V2),
    [`${DRAFTS}/older-copy.sql`]: fn(S4_HEAD, BODY_V1),
  });
  assert.deepEqual(inspectFunctionCollisions(root), []);
});

test("two promotable drafts with different bodies fail, and an entry on either side clears the pair", () => {
  const first = `${DRAFTS}/ovd-723-contract.sql`;
  const second = `${DRAFTS}/ovd-762-fanout.sql`;
  const files = {
    [first]: fn(S4_HEAD, BODY_V1),
    [second]: fn(S4_HEAD, BODY_V2),
  };
  const violations = inspectFunctionCollisions(makeTree(files));
  assert.equal(violations.length, 1);
  assert.match(violations[0], /define it differently, and whichever is promoted second replaces the other/);
  assert.deepEqual(
    inspectFunctionCollisions(makeTree({ ...files, [SUPERSESSIONS_FILE]: allowlist([S4, second, md5(BODY_V1)]) })),
    [],
  );
  assert.deepEqual(
    inspectFunctionCollisions(makeTree({ ...files, [SUPERSESSIONS_FILE]: allowlist([S4, first, md5(BODY_V2)]) })),
    [],
  );
});

test("two drafts with the same body never collide", () => {
  const root = makeTree({
    [`${DRAFTS}/one.sql`]: fn(S4_HEAD, BODY_V1),
    [`${DRAFTS}/two.sql`]: fn(S4_HEAD, BODY_V1),
  });
  assert.deepEqual(inspectFunctionCollisions(root), []);
});

test("rollback drafts and retired drafts are not promotion candidates", () => {
  const root = makeTree({
    [migrationV1]: fn(S4_HEAD, BODY_V1),
    [`${DRAFTS}/ovd-762-fanout.rollback.sql`]: fn(S4_HEAD, BODY_DRAFT),
    [`${DRAFTS}/old-superseded.sql`]: `-- SUPERSEDED by ovd-762-fanout.sql. Kept as history only.\n${fn(S4_HEAD, BODY_DRAFT)}`,
    [`${DRAFTS}/never-apply.sql`]: `-- Do not apply this draft.\n${fn(S4_HEAD, BODY_V2)}`,
  });
  assert.deepEqual(inspectFunctionCollisions(root), []);
});

test("a function dropped by the last migration has no deployed body to replace", () => {
  const root = makeTree({
    [migrationV1]: fn(S4_HEAD, BODY_V1),
    [migrationV2]: `drop function if exists ${S4};\n`,
    [draftS4]: fn(S4_HEAD, BODY_DRAFT),
  });
  assert.deepEqual(inspectFunctionCollisions(root), []);
});

test("a function recreated after a drop is deployed again", () => {
  const root = makeTree({
    [migrationV1]: `${fn(S4_HEAD, BODY_V1)}drop function ${S4};\n${fn(S4_HEAD, BODY_V2)}`,
    [draftS4]: fn(S4_HEAD, BODY_DRAFT),
  });
  const violations = inspectFunctionCollisions(root);
  assert.equal(violations.length, 1);
  assert.ok(violations[0].includes(`(md5 ${md5(BODY_V2)})`));
});

test("the last definition in a draft file is the one that would be promoted", () => {
  const root = makeTree({
    [migrationV1]: fn(S4_HEAD, BODY_V1),
    [draftS4]: fn(S4_HEAD, BODY_DRAFT) + fn(S4_HEAD, BODY_V1),
  });
  assert.deepEqual(inspectFunctionCollisions(root), []);
});

test("spelling differences in argument types still meet as one function", () => {
  const root = makeTree({
    [migrationV1]: fn("public.f(p int, q timestamptz)", BODY_V1),
    [draftS4]: fn("public.f(a integer, b timestamp with time zone)", BODY_DRAFT),
  });
  const violations = inspectFunctionCollisions(root);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /^public\.f\(integer,timestamptz\):/);
});

test("different argument types are another function and never collide", () => {
  const root = makeTree({
    [migrationV1]: fn("public.f(p uuid)", BODY_V1),
    [draftS4]: fn("public.f(p uuid, p_marker uuid)", BODY_DRAFT),
  });
  assert.deepEqual(inspectFunctionCollisions(root), []);
});

test("an entry nothing needs is reported, whether the draft changed or went away", () => {
  const root = makeTree({
    [migrationV1]: fn(S4_HEAD, BODY_V1),
    [SUPERSESSIONS_FILE]: allowlist([S4, `${DRAFTS}/deleted-draft.sql`, md5(BODY_V1)]),
  });
  const violations = inspectFunctionCollisions(root);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /unused entry for public\.api_authorize_worker_dispatch\(uuid,uuid,jsonb,text,timestamptz\) in docs\/migration-drafts\/deleted-draft\.sql/);
});

test("a missing allowlist file is the same as an empty one", () => {
  const root = makeTree({ [migrationV1]: fn(S4_HEAD, BODY_V1) });
  assert.deepEqual(inspectFunctionCollisions(root), []);
});

// ---- allowlist format -------------------------------------------------------

test("the allowlist must be versioned JSON whose entries name file, signature, md5 and reason", () => {
  assert.throws(() => parseSupersessions("{"), /not valid JSON/);
  assert.throws(() => parseSupersessions('{"version": 2, "supersessions": []}'), /must be \{"version": 1/);
  assert.throws(() => parseSupersessions('{"version": 1}'), /must be \{"version": 1/);
  const entry = { signature: S4, file: draftS4, supersedesMd5: md5("x"), reason: "why" };
  for (const field of ["signature", "file", "supersedesMd5", "reason"]) {
    const broken = { ...entry, [field]: "  " };
    assert.throws(
      () => parseSupersessions(JSON.stringify({ version: 1, supersessions: [broken] })),
      new RegExp(`"${field}" must be a non-empty string`),
    );
  }
  assert.throws(
    () => parseSupersessions(JSON.stringify({ version: 1, supersessions: [{ ...entry, supersedesMd5: "ABC" }] })),
    /32 lowercase hex characters/,
  );
  assert.deepEqual(parseSupersessions(JSON.stringify({ version: 1, supersessions: [entry] })), [entry]);
});

// ---- command line -----------------------------------------------------------

function runCli(root) {
  return spawnSync(process.execPath, [SCRIPT, "--root", root], { encoding: "utf8" });
}

test("the command exits 0 on a clean tree and 1 with the violation on stderr otherwise", () => {
  const clean = runCli(makeTree({ [migrationV1]: fn(S4_HEAD, BODY_V1), [draftS4]: fn(S4_HEAD, BODY_V1) }));
  assert.equal(clean.status, 0);
  assert.match(clean.stdout, /Migration function collision check passed\./);

  const dirty = runCli(makeTree({ [migrationV1]: fn(S4_HEAD, BODY_V1), [draftS4]: fn(S4_HEAD, BODY_DRAFT) }));
  assert.equal(dirty.status, 1);
  assert.match(dirty.stderr, /Migration function collision check failed:/);
  assert.match(dirty.stderr, /would replace the deployed body/);
});

test("the command fails closed on an unreadable allowlist", () => {
  const result = runCli(makeTree({ [migrationV1]: fn(S4_HEAD, BODY_V1), [SUPERSESSIONS_FILE]: "not json" }));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /could not run: .*not valid JSON/);
});
