import { readFileSync, writeSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BOTH = ['codex-xhigh', 'claude-sonnet'];
const FAMILIES = new Set(['claude', 'openai', 'grok', 'jev']);
const DEFAULT_ROUTING = new URL('../fixtures/agent-graph/model-routing.v2.yaml', import.meta.url);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (object, key) => Object.hasOwn(object, key);

const ID_PATTERN = /^[a-z0-9-]+$/;

function validateShape(routing) {
  if (!record(routing) || !record(routing.pools) || !Object.keys(routing.pools).length ||
      !Array.isArray(routing.bots) || !routing.bots.length || !record(routing.review_routing)) {
    throw new Error('Invalid routing shape');
  }
}

function validatePools(pools) {
  for (const [id, pool] of Object.entries(pools)) {
    if (!ID_PATTERN.test(id) || !record(pool) || !FAMILIES.has(pool.family)) {
      throw new Error('Invalid pool or family');
    }
  }
}

function validateBots(bots) {
  const ids = new Set();
  for (const bot of bots) {
    if (!record(bot) || typeof bot.id !== 'string' || !ID_PATTERN.test(bot.id) ||
        ids.has(bot.id) || typeof bot.display !== 'string' || !bot.display.trim() ||
        typeof bot.may_build !== 'boolean') throw new Error('Invalid bot');
    ids.add(bot.id);
  }
}

function validateReviewRoutes(routing) {
  for (const [family, target] of Object.entries(routing.review_routing)) {
    if (!FAMILIES.has(family) || typeof target !== 'string') throw new Error('Invalid review route');
    const pool = target === 'openai' ? 'codex-xhigh' : target;
    if (!own(routing.pools, pool) || routing.pools[pool].family === family) {
      throw new Error('Review route must name a cross-family pool');
    }
  }
  for (const family of ['claude', 'grok', 'openai']) {
    if (!own(routing.review_routing, family)) throw new Error('Missing review route');
  }
}

function validateFailSafe(routing) {
  for (const field of ['unknown_builder', 'mixed_builder']) {
    if (!Array.isArray(routing[field]) || routing[field].length !== 2 ||
        !BOTH.every(pool => routing[field].includes(pool) && own(routing.pools, pool))) {
      throw new Error('Invalid fail-safe pools');
    }
  }
  if (routing.pools['codex-xhigh'].family !== 'openai' ||
      routing.pools['claude-sonnet'].family !== 'claude') throw new Error('Invalid fail-safe families');
}

function validateRouting(routing) {
  validateShape(routing);
  validatePools(routing.pools);
  validateBots(routing.bots);
  validateReviewRoutes(routing);
  validateFailSafe(routing);
  return routing;
}

// JSON-compatible YAML only: no undeclared YAML dependency or custom YAML grammar.
export function loadRouting(path) {
  return validateRouting(JSON.parse(readFileSync(path, 'utf8')));
}

const FREE_TEXT_POOLS = [
  ['claude-opus', 'claude-opus'], ['opus', 'claude-opus'],
  ['claude', 'claude-sonnet'], ['sonnet', 'claude-sonnet'],
  ['codex', 'codex'], ['gpt', 'codex'], ['openai', 'codex'],
  ['grok', 'grok-overflow'], ['jev', 'jev'],
];
const OTHER_BUILDER = /[+,]\s*(?:codex|gpt|openai|claude|sonnet|opus|grok|jev)/i;
const TOKEN_CHARACTER = /[a-z0-9-]/i;

// Splits "<bot> / <family> <context>" with string scans instead of one
// backtracking regex, so a hostile PR body cannot make the parser super-linear.
function splitFreeText(entry) {
  const text = entry.trim();
  const slash = text.indexOf('/');
  const bot = slash < 0 ? '' : text.slice(0, slash).trim();
  const rest = text.slice(slash + 1).trimStart();
  if (!bot || !rest) return null;
  const word = rest.split(/\s/, 1)[0];
  let end = word.length;
  while (end > 0 && !TOKEN_CHARACTER.test(word[end - 1])) end -= 1;
  return { bot, token: word.slice(0, end), trailing: word.slice(end), context: rest.slice(word.length) };
}

// Text outside balanced parentheses, or null when the parentheses are unbalanced.
function outsideParentheses(text) {
  let depth = 0;
  let outside = '';
  for (const character of text) {
    if (character === '(') {
      depth += 1;
    } else if (character === ')') {
      if (!depth) return null;
      depth -= 1;
    } else if (!depth) {
      outside += character;
    }
  }
  return depth ? null : outside;
}

function readFreeText(entry, routing) {
  const parts = splitFreeText(entry);
  if (!parts) return [];
  const { token } = parts;
  const pool = FREE_TEXT_POOLS.find(([prefix]) => token.toLowerCase().startsWith(prefix))?.[1];
  if (!pool || !own(routing.pools, pool)) return [];
  // Parenthetical context may name other models; outside it, another builder
  // must fail safe rather than silently attributing the line to its first model.
  const outside = outsideParentheses(parts.context);
  if (outside === null || OTHER_BUILDER.test(parts.trailing + outside)) return [];
  const name = parts.bot.toLowerCase();
  const bot = routing.bots.find(bot => bot.id.toLowerCase() === name || bot.display.toLowerCase() === name)?.id
    ?? name.replace(/\s+/g, '-');
  return [{ bot, model: `model:${pool}`, token }];
}

const textLines = text => text.split(/\r?\n/);
// One definition of "a Built-by line", used both to detect a commit trailer and to read it.
const builtByLines = text => textLines(text).filter(line => /^\s*Built-by:/i.test(line));

function readTags(text, findings, routing) {
  const lines = builtByLines(text);
  if (lines.length > 1) findings.push('Multiple Built-by lines; use one semicolon-separated line');
  if (lines.length) {
    return lines.flatMap(line => line.replace(/^\s*Built-by:\s*/i, '').split(';').flatMap(entry => {
      const match = /^bot=([a-z0-9-]+)\s+model=(model:[a-z0-9-]+)$/.exec(entry.trim());
      if (!match) {
        const freeText = readFreeText(entry, routing);
        if (freeText.length) return freeText;
        findings.push('Unparseable Built-by line');
        return [];
      }
      return [{ bot: match[1], model: match[2] }];
    }));
  }
  const legacy = textLines(text).filter(line => /^\s*Model:/i.test(line));
  return legacy.flatMap(line => {
    const match = /^\s*Model:\s*(model:[a-z0-9-]+)\s*$/i.exec(line);
    if (!match) { findings.push('Unparseable Model line'); return []; }
    return [{ bot: 'unknown', model: match[1] }];
  });
}

// Only Built-by commit metadata is supported; legacy Model is body-only.
function readCommitTags(commits, bodyBuilders, findings, routing) {
  const trailerBuilders = [];
  const commitEntries = [];
  let untagged = 0;
  for (const commit of commits) {
    if (!record(commit) || typeof commit.message !== 'string') throw new TypeError('Invalid commit');
    if (builtByLines(commit.message).length) {
      const tags = readTags(commit.message, findings, routing);
      trailerBuilders.push(...tags);
      commitEntries.push(...tags);
    } else {
      untagged += 1;
      commitEntries.push(...bodyBuilders);
    }
  }
  // Some commits attribute a builder and others have neither a trailer nor a
  // body history to fall back on: that commit's builder is unknown, so the
  // attribution is incomplete and must not narrow review.
  if (untagged && trailerBuilders.length && !bodyBuilders.length) {
    findings.push('Commit without Built-by trailer and no body history');
  }
  return { trailerBuilders, commitEntries };
}

// Trailers can cover only some commits. Each must appear in the body's
// declared builder history, in order; otherwise the two claims conflict.
function trailersDisagreeWithBody(trailerBuilders, bodyBuilders) {
  let cursor = 0;
  for (const builder of trailerBuilders) {
    const index = bodyBuilders.findIndex((entry, i) => i >= cursor && entry.model === builder.model);
    if (index < 0) return true;
    cursor = index; // repeated commits by the same builder are valid
  }
  return false;
}

function describeBuilder(entry, routing, findings) {
  const id = entry.model.slice('model:'.length);
  const family = own(routing.pools, id) ? routing.pools[id].family : 'unknown';
  const bot = routing.bots.find(candidate => candidate.id === entry.bot);
  if (!bot) findings.push(`Unknown bot: ${entry.bot}`);
  else if (!bot.may_build) findings.push(`Bot may not build: ${entry.bot}`);
  if (family === 'unknown') findings.push(`Unknown model: ${entry.model}`);
  return { ...entry, family };
}

// Walk commits in caller-supplied commit order, using body history only
// for commits lacking a trailer. Adjacent identical builders collapse.
function resolveBuilders(entries, routing, findings) {
  return entries.map(entry => describeBuilder(entry, routing, findings))
    .filter((entry, index, all) => index === 0 ||
      entry.bot !== all[index - 1].bot || entry.model !== all[index - 1].model);
}

// Returns true when a model label contradicts the declared builder history:
// the body's, or the resolved commit-trailer builders when the body has none.
function modelLabelsConflict({ labels, bodyBuilders, builders, routing, findings }) {
  const modelLabels = labels.map(label => typeof label === 'string' ? label : label?.name)
    .filter(label => typeof label === 'string' && label.startsWith('model:'));
  if (builders.length === 1 && modelLabels.length > 1) findings.push('Multiple model labels on single-builder PR');
  const history = bodyBuilders.length ? bodyBuilders : builders;
  let conflict = false;
  for (const label of modelLabels) {
    if (!own(routing.pools, label.slice(6))) findings.push(`Unknown model label: ${label}`);
    if (history.length && !history.some(builder => builder.model === label)) {
      conflict = true;
      findings.push(`Model label disagrees with builder history: ${label}`);
    }
  }
  return conflict;
}

function statusOf({ conflict, findings, builders }) {
  if (conflict) return 'conflict';
  if (findings.length) return 'unknown';
  if (new Set(builders.map(builder => builder.family)).size > 1) return 'mixed';
  return builders.length ? 'ok' : 'missing';
}

export function parseBuiltBy(input) {
  try {
    const { body = '', labels = [], commits = [], routing } = input;
    validateRouting(routing);
    if (typeof body !== 'string' || !Array.isArray(labels) || !Array.isArray(commits)) {
      throw new TypeError('Invalid parser input');
    }
    const findings = [];
    const bodyBuilders = readTags(body, findings, routing);
    const { trailerBuilders, commitEntries } = readCommitTags(commits, bodyBuilders, findings, routing);
    let conflict = false;
    if (trailerBuilders.length && bodyBuilders.length &&
        trailersDisagreeWithBody(trailerBuilders, bodyBuilders)) {
      conflict = true;
      findings.push('Commit trailer model disagrees with body');
    }
    const builders = resolveBuilders(commits.length ? commitEntries : bodyBuilders, routing, findings);
    if (modelLabelsConflict({ labels, bodyBuilders, builders, routing, findings })) conflict = true;
    return { builders, status: statusOf({ conflict, findings, builders }), findings: [...new Set(findings)] };
  } catch {
    return { builders: [], status: 'unknown', findings: ['Parser error: invalid input or routing'] };
  }
}

export function reviewFamilies(parsed, options = {}) {
  let extra = [];
  let available;
  let required = [...BOTH];
  try {
    // Read extras first so routing/parser errors cannot discard additional review.
    if (Array.isArray(options?.extra)) extra = [...options.extra];
    available = options?.available;
    const routing = validateRouting(options?.routing);
    if (parsed?.status === 'ok' && Array.isArray(parsed.builders) && parsed.builders.length &&
        parsed.builders.every(builder => FAMILIES.has(builder.family) &&
          builder.family === parsed.builders[0].family && builder.bot !== 'unknown' &&
          routing.bots.some(bot => bot.id === builder.bot && bot.may_build) &&
          typeof builder.model === 'string' && builder.model.startsWith('model:') &&
          own(routing.pools, builder.model.slice(6)) &&
          routing.pools[builder.model.slice(6)].family === builder.family)) {
      const target = routing.review_routing[parsed.builders[0].family];
      const pool = target === 'openai' ? 'codex-xhigh' : target;
      if (own(routing.pools, pool)) required = [pool];
    }
  } catch { /* Report-only fail-safe: retain both reviewers and any extras. */ }
  try {
    if (available !== undefined) {
      const pools = new Set(available);
      if (!required.some(pool => pools.has(pool))) required = ['queue'];
    }
  } catch { required = ['queue']; }
  return [...new Set([...required, ...extra])];
}

function cli(args) {
  let result;
  let routing;
  try {
    const options = {};
    for (let i = 0; i < args.length; i++) {
      const flag = args[i];
      if (flag === '--json') continue;
      if (!['--body', '--labels', '--routing'].includes(flag) || !args[i + 1] || args[i + 1].startsWith('--')) {
        throw new Error('Expected --body <file> [--labels a,b] [--routing <yaml>] [--json]');
      }
      options[flag.slice(2)] = args[++i];
    }
    if (!options.body) throw new Error('Missing --body file');
    routing = loadRouting(options.routing ?? DEFAULT_ROUTING);
    result = parseBuiltBy({ body: readFileSync(options.body, 'utf8'), labels: options.labels?.split(',') ?? [], routing });
  } catch {
    result = { builders: [], status: 'unknown', findings: ['CLI error: invalid arguments, unreadable file, or invalid routing'] };
  }
  // Flush the report before this short-lived CLI exits.
  writeSync(1, `${JSON.stringify({ ...result, reviewers: reviewFamilies(result, { routing }) }, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) cli(process.argv.slice(2));
