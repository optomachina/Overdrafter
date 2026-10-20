/** Offline function collision messages only. Reads SQL text; never applies or rewrites migrations. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  SUPERSESSIONS_FILE,
  bodySha256,
  findFunctionCollisions,
  inspectFunctionCollisions,
  parseSupersessions,
  prosrcMd5,
  scanFunctionEvents,
} from "./check-migration-function-collisions.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "check-migration-function-collisions.mjs");
const S4 = "public.api_authorize_worker_dispatch(uuid,uuid,jsonb,text,timestamptz)";
const S4_HEAD = "public.api_authorize_worker_dispatch(p_task uuid, p_lane uuid, p_payload jsonb, p_reason text, p_now timestamptz)";

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

/** Entries are [signature, file, digest]; a 64 character digest is a sha256, a 32 character one an md5. */
function allowlist(...entries) {
  return JSON.stringify({
    version: 1,
    supersessions: entries.map(([signature, file, digest]) => ({
      signature,
      file,
      [digest.length === 64 ? "supersedesSha256" : "supersedesMd5"]: digest,
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

test("a body is the exact text between the dollar quotes, identified by its sha256", () => {
  // FIPS 180-2 test vectors, so the expected values do not come from the code under test.
  for (const [body, expected] of [
    ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
    ["message digest", "f7846f55cf23e14eebeab5b4e1550cad5b509e3348fbc4efa3a1413d393cb650"],
  ]) {
    const [event] = scanFunctionEvents(fn(S4_HEAD, body));
    assert.equal(event.signature, S4);
    assert.equal(event.body, body);
    assert.equal(event.bodySha256, expected);
    assert.equal(event.bodyBytes, Buffer.byteLength(body, "utf8"));
    assert.equal(event.action, "define");
  }
  const [padded] = scanFunctionEvents(fn(S4_HEAD, BODY_V1));
  assert.notEqual(padded.bodySha256, bodySha256(BODY_V1.trim()), "leading and trailing whitespace inside the quotes is part of the body");
  assert.equal(padded.bodySha256, bodySha256(BODY_V1));
  assert.equal("bodyMd5" in padded, false, "an md5 is computed only to match an allowlist entry that names one");
});

test("prosrcMd5 is the md5(pg_proc.prosrc) value PostgreSQL prints", () => {
  // RFC 1321 appendix A.5, then lengths around the 64 byte block and padding
  // boundaries and a multibyte UTF-8 body; those values come from the md5 command
  // line tool, not from the code under test.
  for (const [body, expected] of [
    ["", "d41d8cd98f00b204e9800998ecf8427e"],
    ["a", "0cc175b9c0f1b6a831c399e269772661"],
    ["abc", "900150983cd24fb0d6963f7d28e17f72"],
    ["message digest", "f96b697d7cb7938d525a2f31aaf161d0"],
    ["abcdefghijklmnopqrstuvwxyz", "c3fcd3d76192e4007dfb496cca67e13b"],
    ["ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789", "d174ab98d277d9f5a5611c2c9f419d9f"],
    ["1234567890".repeat(8), "57edf4a22be3c955ac49da2e2107b67a"],
    ["x".repeat(55), "04364420e25c512fd958a70738aa8f72"],
    ["x".repeat(56), "668a72d5ba17f08e62dabcafad6db14b"],
    ["x".repeat(63), "7dc2ca208106a2f703567bdff99d8981"],
    ["x".repeat(64), "c1bb4f81d892b2d57947682aeb252456"],
    ["x".repeat(65), "1bc932052302d074bdec39795fe00cf6"],
    ["x".repeat(119), "ab347a5f68c8a443cfcddc633f12c24f"],
    ["x".repeat(120), "fb98667f98096de92620b64f46e1c5b5"],
    ["select \u00e9t\u00e9 -- \u20ac \u{1F600}", "874e890a69c1d16575474112ebabca3d"],
  ]) {
    assert.equal(prosrcMd5(body), expected, JSON.stringify(body));
  }
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

test("integer[], integer[3], integer ARRAY and integer ARRAY[3] are one argument type", () => {
  const spellings = ["p integer[]", "p int4[3]", "p integer ARRAY", "p int ARRAY[3]", "integer ARRAY", "IN p integer array"];
  for (const argument of spellings) {
    const [event] = scanFunctionEvents(fn(`public.f(${argument}, q text)`, "x"));
    assert.equal(event.signature, "public.f(integer[],text)", argument);
  }
});

test("a quoted type name keeps its case and an unquoted one is folded", () => {
  const signatureOf = (argument) => scanFunctionEvents(fn(`public.f(p ${argument})`, "x"))[0].signature;
  assert.equal(signatureOf('public."MyType"'), 'public.f(MyType)');
  assert.equal(signatureOf("public.mytype"), "public.f(mytype)");
  assert.equal(signatureOf('"public"."mytype"'), "public.f(mytype)", "a quoted lower case name is the unquoted one");
  assert.equal(signatureOf("Public.MyType"), "public.f(mytype)");
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
    String.raw`select E'it\'s create function public.in_escape_string()';`,
    'do $do$ begin execute $q$create function public.in_do_block() returns int as $b$ x $b$$q$; end $do$;',
    fn("public.real_one()", "select 1;", "$body$"),
  ].join("\n");
  assert.deepEqual(scanFunctionEvents(sql).map((event) => event.signature), ["public.real_one()"]);
});

test("a dollar quoted body may contain other dollar quotes and semicolons", () => {
  const body = "\nbegin\n  perform $inner$ a; b; $inner$;\nend;\n";
  const [event] = scanFunctionEvents(fn("public.outer_fn()", body, "$outer$"));
  assert.equal(event.bodySha256, bodySha256(body));
});

test("a single quoted body unescapes doubled quotes and keeps backslashes", () => {
  const sql = String.raw`create function public.quoted() returns text language sql as 'select ''hi\n'';';`;
  const [event] = scanFunctionEvents(sql);
  assert.equal(event.body, String.raw`select 'hi\n';`);
  assert.equal(event.bodySha256, bodySha256(String.raw`select 'hi\n';`));
});

/** The body an E'...' string stores, as this check reads it (null when it refuses it). */
function escapeBody(literal) {
  return scanFunctionEvents(`create function public.e() returns text language sql as E'${literal}';`)[0].body;
}

test("an escape string body is decoded the way PostgreSQL stores it", () => {
  // Each literal is the SQL text between E' and the closing quote.
  for (const [literal, stored] of [
    [String.raw`select ''\n'';`, "select '\n';"],
    [String.raw`a\b\f\n\r\tz`, "a\b\f\n\r\tz"],
    [String.raw`it\'s, it''s`, "it's, it's"],
    [String.raw`back\\slash`, "back\\slash"],
    [String.raw`\101\x42\u0043\U00000044`, "ABCD"],
    [String.raw`caf\303\251 = caf\u00e9 = caf\xc3\xa9`, "caf\u00e9 = caf\u00e9 = caf\u00e9"],
    [String.raw`\U0001F600`, "\u{1F600}"],
    [String.raw`\%\_\"\\`, '%_"\\'],
  ]) {
    assert.equal(escapeBody(literal), stored, literal);
  }
});

test("an escape string body this check cannot decode with certainty is unreadable, not guessed", () => {
  for (const literal of [
    String.raw`a\vb`, // \v is not a documented escape
    String.raw`a\qb`, // any other letter
    String.raw`a\8b`, // a digit that is not octal
    String.raw`a\xzb`, // \x without a hex digit
    String.raw`a\u12b`, // \u needs four hex digits (an error in PostgreSQL)
    String.raw`a\ud83d\ude00b`, // surrogates
    String.raw`a\000b`, // a zero byte (an error in PostgreSQL)
    String.raw`a\xffb`, // not valid UTF-8 (an error in PostgreSQL)
    String.raw`a\U00110000b`, // past U+10FFFF
  ]) {
    assert.equal(escapeBody(literal), null, literal);
  }
  const sql = String.raw`create function public.e() returns text language sql as E'a\vb';`;
  const violations = findFunctionCollisions(
    scanFunctionEvents(sql).map((event) => ({ ...event, file: draftS4, kind: "draft" })),
  );
  assert.equal(violations.length, 1);
  assert.match(violations[0], /public\.e\(\) has no body this check can read/);
});

test("an escape string that differs from a plain one only by its escapes is a different body", () => {
  // Codex review: E'select ''\n'';' (one SQL backslash) stores a newline and
  // 'select ''n'';' stores the letter n. Hashing them alike let a changed draft
  // pass as a copy of the deployed body.
  const escaped = String.raw`create or replace function public.g() returns text language sql as E'select ''\n'';';`;
  const plain = "create or replace function public.g() returns text language sql as 'select ''n'';';";
  const [escapedEvent] = scanFunctionEvents(escaped);
  const [plainEvent] = scanFunctionEvents(plain);
  assert.notEqual(escapedEvent.bodySha256, plainEvent.bodySha256);

  const violations = inspectFunctionCollisions(makeTree({ [migrationV1]: plain, [draftS4]: escaped }));
  assert.equal(violations.length, 1);
  assert.match(violations[0], /^public\.g\(\): .* would replace the deployed body from /);

  const sameText = String.raw`create or replace function public.g() returns text language sql as E'select ''\156'';';`;
  assert.deepEqual(
    inspectFunctionCollisions(makeTree({ [migrationV1]: plain, [draftS4]: sameText })),
    [],
    "an escape that stores the same text (\\156 is n) is the same body",
  );
});

test("a string body continued on the next line, or a U& string, is unreadable rather than guessed", () => {
  const sql = "create function public.c() returns int language sql as 'select 1'\n  ' + 1';";
  const [event] = scanFunctionEvents(sql);
  assert.equal(event.body, null);
  const [unicode] = scanFunctionEvents(String.raw`create function public.u() returns text language sql as U&'select ''\0061'';';`);
  assert.equal(unicode.body, null);
  const [separate] = scanFunctionEvents("create function public.c() returns int language c as 'module', 'symbol';");
  assert.equal(separate.body, "module", "a C function's object file and link symbol are separated by a comma");
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
  assert.equal(event.body, null);
  assert.equal(event.bodySha256, null);
  const violations = findFunctionCollisions([{ ...event, file: `${MIGRATIONS}/20260101000000_x.sql`, kind: "migration" }]);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /public\.atomic_body\(integer\) has no body this check can read/);
});

// ---- decisions on whole trees -----------------------------------------------

test("migrations that restate each other are history, not a collision (a deliberate scope limit)", () => {
  // The check covers pairs that involve a draft. Two migrations that restate one
  // function from the same base (the concurrent-migration case) are not compared;
  // docs/migration-function-collisions.md lists that under "Not covered".
  const root = makeTree({
    [migrationV1]: fn(S4_HEAD, BODY_V1),
    [migrationV2]: fn(S4_HEAD, BODY_V2),
    [`${MIGRATIONS}/20261020110000_s4_other_branch.sql`]: fn(S4_HEAD, BODY_DRAFT),
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
  assert.ok(violations[0].includes(`(sha256 ${bodySha256(BODY_DRAFT)}) would replace the deployed body from ${migrationV1} (sha256 ${bodySha256(BODY_V1)})`));
  assert.ok(violations[0].includes(`"supersedesSha256":"${bodySha256(BODY_V1)}"`));
  assert.ok(violations[0].includes(SUPERSESSIONS_FILE));
});

test("naming the superseded body's sha256 in the allowlist clears the draft", () => {
  const root = makeTree({
    [migrationV1]: fn(S4_HEAD, BODY_V1),
    [draftS4]: fn(S4_HEAD, BODY_DRAFT),
    [SUPERSESSIONS_FILE]: allowlist([S4, draftS4, bodySha256(BODY_V1)]),
  });
  assert.deepEqual(inspectFunctionCollisions(root), []);
});

test("OVD-762 against OVD-987: a newer migration body makes the old entry stale and fails until the draft is rebased", () => {
  const files = {
    [migrationV1]: fn(S4_HEAD, BODY_V1),
    [draftS4]: fn(S4_HEAD, BODY_DRAFT),
    [SUPERSESSIONS_FILE]: allowlist([S4, draftS4, bodySha256(BODY_V1)]),
  };
  assert.deepEqual(inspectFunctionCollisions(makeTree(files)), []);

  const quantityLands = makeTree({ ...files, [migrationV2]: fn(S4_HEAD, BODY_V2) });
  const violations = inspectFunctionCollisions(quantityLands);
  assert.equal(violations.length, 2);
  assert.ok(violations.some((line) => line.includes(`would replace the deployed body from ${migrationV2} (sha256 ${bodySha256(BODY_V2)})`)));
  assert.ok(violations.some((line) => line.includes(`unused entry for ${S4} in ${draftS4} naming sha256 ${bodySha256(BODY_V1)}`)));

  const rebased = makeTree({
    ...files,
    [migrationV2]: fn(S4_HEAD, BODY_V2),
    [SUPERSESSIONS_FILE]: allowlist([S4, draftS4, bodySha256(BODY_V2)]),
  });
  assert.deepEqual(inspectFunctionCollisions(rebased), []);
});

test("a draft that equals the deployed body is an archived copy", () => {
  const root = makeTree({
    [migrationV1]: fn(S4_HEAD, BODY_V1),
    [migrationV2]: fn(S4_HEAD, BODY_V2),
    [`${DRAFTS}/promoted-copy.sql`]: fn(S4_HEAD, BODY_V2),
  });
  assert.deepEqual(inspectFunctionCollisions(root), []);
});

test("a draft that only equals an older migration body is stale and fails against the deployed body", () => {
  const olderCopy = `${DRAFTS}/older-copy.sql`;
  const files = {
    [migrationV1]: fn(S4_HEAD, BODY_V1),
    [migrationV2]: fn(S4_HEAD, BODY_V2),
    [olderCopy]: fn(S4_HEAD, BODY_V1),
  };
  const violations = inspectFunctionCollisions(makeTree(files));
  assert.equal(violations.length, 1);
  assert.ok(violations[0].includes(`${olderCopy} (sha256 ${bodySha256(BODY_V1)}) would replace the deployed body from ${migrationV2} (sha256 ${bodySha256(BODY_V2)})`));
  assert.deepEqual(
    inspectFunctionCollisions(makeTree({ ...files, [SUPERSESSIONS_FILE]: allowlist([S4, olderCopy, bodySha256(BODY_V2)]) })),
    [],
    "naming the deployed body is the documented way to accept the replacement",
  );
  assert.deepEqual(
    inspectFunctionCollisions(makeTree({
      ...files,
      [olderCopy]: `-- SUPERSEDED by ${migrationV2}. Kept as history only.\n${fn(S4_HEAD, BODY_V1)}`,
    })),
    [],
    "a retirement header is explicit evidence that the copy will not be promoted",
  );
});

test("a verbatim copy of the deployed body starts failing once a newer migration changes the function", () => {
  const copy = `${DRAFTS}/verbatim-copy.sql`;
  const files = {
    [migrationV1]: fn(S4_HEAD, BODY_V1),
    [copy]: fn(S4_HEAD, BODY_V1),
  };
  assert.deepEqual(inspectFunctionCollisions(makeTree(files)), []);

  const violations = inspectFunctionCollisions(makeTree({ ...files, [migrationV2]: fn(S4_HEAD, BODY_V2) }));
  assert.equal(violations.length, 1);
  assert.ok(violations[0].includes(`${copy} (sha256 ${bodySha256(BODY_V1)}) would replace the deployed body from ${migrationV2}`));
});

test("a stale draft that restores an older body over a newer one fails without a supersession entry", () => {
  const root = makeTree({
    [migrationV1]: fn("public.flag()", "select true;"),
    [migrationV2]: fn("public.flag()", "select false;"),
    [draftS4]: fn("public.flag()", "select true;"),
  });
  const violations = inspectFunctionCollisions(root);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /^public\.flag\(\): .* would replace the deployed body from /);
  assert.ok(violations[0].includes(`"supersedesSha256":"${bodySha256("select false;")}"`));
});

test("a copy of the deployed body is compared again once the draft it sat beside is promoted", () => {
  const copy = `${DRAFTS}/archived-copy.sql`;
  const rebased = `${DRAFTS}/ovd-762-fanout.sql`;
  const beforePromotion = {
    [migrationV1]: fn(S4_HEAD, BODY_V1),
    [copy]: fn(S4_HEAD, BODY_V1),
    [rebased]: fn(S4_HEAD, BODY_V2),
    [SUPERSESSIONS_FILE]: allowlist([S4, rebased, bodySha256(BODY_V1)]),
  };
  assert.deepEqual(inspectFunctionCollisions(makeTree(beforePromotion)), []);

  // The rebased draft is promoted: its file moves into supabase/migrations and its entry is removed.
  const afterPromotion = {
    [migrationV1]: beforePromotion[migrationV1],
    [migrationV2]: fn(S4_HEAD, BODY_V2),
    [copy]: beforePromotion[copy],
  };
  const violations = inspectFunctionCollisions(makeTree(afterPromotion));
  assert.equal(violations.length, 1);
  assert.ok(violations[0].includes(`${copy} (sha256 ${bodySha256(BODY_V1)}) would replace the deployed body from ${migrationV2}`));
});

test("a draft equal to the body a migration later dropped has nothing deployed to replace", () => {
  const root = makeTree({
    [migrationV1]: fn(S4_HEAD, BODY_V1),
    [migrationV2]: `drop function if exists ${S4};\n`,
    [draftS4]: fn(S4_HEAD, BODY_V1),
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
    inspectFunctionCollisions(makeTree({ ...files, [SUPERSESSIONS_FILE]: allowlist([S4, second, bodySha256(BODY_V1)]) })),
    [],
  );
  assert.deepEqual(
    inspectFunctionCollisions(makeTree({ ...files, [SUPERSESSIONS_FILE]: allowlist([S4, first, bodySha256(BODY_V2)]) })),
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
  assert.ok(violations[0].includes(`(sha256 ${bodySha256(BODY_V2)})`));
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
    [SUPERSESSIONS_FILE]: allowlist([S4, `${DRAFTS}/deleted-draft.sql`, bodySha256(BODY_V1)]),
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

test("the allowlist must be versioned JSON whose entries name file, signature, one superseded body and reason", () => {
  const parse = (...entries) => parseSupersessions(JSON.stringify({ version: 1, supersessions: entries }));
  assert.throws(() => parseSupersessions("{"), /not valid JSON/);
  assert.throws(() => parseSupersessions('{"version": 2, "supersessions": []}'), /must be \{"version": 1/);
  assert.throws(() => parseSupersessions('{"version": 1}'), /must be \{"version": 1/);
  const entry = { signature: S4, file: draftS4, supersedesSha256: bodySha256("x"), reason: "why" };
  for (const field of ["signature", "file", "reason"]) {
    assert.throws(() => parse({ ...entry, [field]: "  " }), new RegExp(`"${field}" must be a non-empty string`));
  }
  const { supersedesSha256: _omitted, ...unnamed } = entry;
  assert.throws(() => parse(unnamed), /exactly one of "supersedesSha256" or "supersedesMd5"/);
  assert.throws(
    () => parse({ ...entry, supersedesMd5: prosrcMd5("x") }),
    /exactly one of "supersedesSha256" or "supersedesMd5"/,
    "naming a body twice could name two different bodies",
  );
  assert.throws(() => parse({ ...entry, supersedesSha256: prosrcMd5("x") }), /"supersedesSha256" must be 64 lowercase hex characters/);
  assert.throws(() => parse({ ...entry, supersedesSha256: bodySha256("x").toUpperCase() }), /64 lowercase hex characters/);
  assert.throws(() => parse({ ...unnamed, supersedesMd5: bodySha256("x") }), /"supersedesMd5" must be 32 lowercase hex characters/);
  assert.throws(() => parse({ ...unnamed, supersedesMd5: 7 }), /"supersedesMd5" must be 32 lowercase hex characters/);
  const md5Entry = { ...unnamed, supersedesMd5: prosrcMd5("x") };
  assert.deepEqual(parse(entry, md5Entry), [entry, md5Entry]);
});

test("an entry may name the superseded body by the md5(pg_proc.prosrc) a migration's notes quote", () => {
  const files = {
    [migrationV1]: fn(S4_HEAD, BODY_V1),
    [draftS4]: fn(S4_HEAD, BODY_DRAFT),
  };
  assert.deepEqual(
    inspectFunctionCollisions(makeTree({ ...files, [SUPERSESSIONS_FILE]: allowlist([S4, draftS4, prosrcMd5(BODY_V1)]) })),
    [],
  );
  // An md5 naming any other body does not clear the draft and is itself unused.
  const wrong = inspectFunctionCollisions(makeTree({ ...files, [SUPERSESSIONS_FILE]: allowlist([S4, draftS4, prosrcMd5(BODY_DRAFT)]) }));
  assert.equal(wrong.length, 2);
  assert.ok(wrong.some((line) => line.includes("would replace the deployed body")));
  assert.ok(wrong.some((line) => line.includes(`unused entry for ${S4} in ${draftS4} naming md5 ${prosrcMd5(BODY_DRAFT)}`)));
  // Two drafts: an md5 entry on either side clears the pair, like a sha256 one.
  const other = `${DRAFTS}/ovd-723-contract.sql`;
  assert.deepEqual(
    inspectFunctionCollisions(makeTree({
      [other]: fn(S4_HEAD, BODY_V1),
      [draftS4]: fn(S4_HEAD, BODY_V2),
      [SUPERSESSIONS_FILE]: allowlist([S4, draftS4, prosrcMd5(BODY_V1)]),
    })),
    [],
  );
});

test("integer ARRAY and integer[] meet as one function", () => {
  // Codex review: the two spellings produced different signatures, so a draft and
  // the deployed migration with different bodies were never compared.
  const root = makeTree({
    [migrationV1]: fn("public.f(p integer[])", BODY_V1),
    [draftS4]: fn("public.f(p integer ARRAY)", BODY_DRAFT),
  });
  const violations = inspectFunctionCollisions(root);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /^public\.f\(integer\[\]\): .* would replace the deployed body from /);
});

test("quoted type names that differ only in case are different functions", () => {
  const root = makeTree({
    [migrationV1]: fn('public.f(p public."MyType")', BODY_V1),
    [draftS4]: fn("public.f(p public.mytype)", BODY_DRAFT),
  });
  assert.deepEqual(inspectFunctionCollisions(root), []);
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
