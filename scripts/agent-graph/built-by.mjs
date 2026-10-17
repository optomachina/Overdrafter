import { readFileSync, writeSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BOTH = ['codex-xhigh', 'claude-sonnet'];
const FAMILIES = new Set(['claude', 'openai', 'grok', 'jev']);
const DEFAULT_ROUTING = new URL('../fixtures/agent-graph/model-routing.v2.yaml', import.meta.url);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (object, key) => Object.hasOwn(object, key);

function validateRouting(routing) {
  if (!record(routing) || !record(routing.pools) || !Object.keys(routing.pools).length ||
      !Array.isArray(routing.bots) || !routing.bots.length || !record(routing.review_routing)) {
    throw new Error('Invalid routing shape');
  }
  for (const [id, pool] of Object.entries(routing.pools)) {
    if (!/^[a-z0-9-]+$/.test(id) || !record(pool) || !FAMILIES.has(pool.family)) {
      throw new Error('Invalid pool or family');
    }
  }
  const ids = new Set();
  for (const bot of routing.bots) {
    if (!record(bot) || typeof bot.id !== 'string' || !/^[a-z0-9-]+$/.test(bot.id) ||
        ids.has(bot.id) || typeof bot.display !== 'string' || !bot.display.trim() ||
        typeof bot.may_build !== 'boolean') throw new Error('Invalid bot');
    ids.add(bot.id);
  }
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
  for (const field of ['unknown_builder', 'mixed_builder']) {
    if (!Array.isArray(routing[field]) || routing[field].length !== 2 ||
        !BOTH.every(pool => routing[field].includes(pool) && own(routing.pools, pool))) {
      throw new Error('Invalid fail-safe pools');
    }
  }
  if (routing.pools['codex-xhigh'].family !== 'openai' ||
      routing.pools['claude-sonnet'].family !== 'claude') throw new Error('Invalid fail-safe families');
  return routing;
}

// JSON-compatible YAML only: no undeclared YAML dependency or custom YAML grammar.
export function loadRouting(path) {
  return validateRouting(JSON.parse(readFileSync(path, 'utf8')));
}

function readTags(text, findings) {
  const lines = text.split(/\r?\n/).filter(line => /^\s*Built-by:/i.test(line));
  if (lines.length > 1) findings.push('Multiple Built-by lines; use one semicolon-separated line');
  if (lines.length) {
    return lines.flatMap(line => line.replace(/^\s*Built-by:\s*/i, '').split(';').flatMap(entry => {
      const match = /^bot=([a-z0-9-]+)\s+model=(model:[a-z0-9-]+)$/.exec(entry.trim());
      if (!match) {
        findings.push('Unparseable Built-by line');
        return [];
      }
      return [{ bot: match[1], model: match[2] }];
    }));
  }
  const legacy = text.split(/\r?\n/).filter(line => /^\s*Model:/i.test(line));
  return legacy.flatMap(line => {
    const match = /^\s*Model:\s*(model:[a-z0-9-]+)\s*$/i.exec(line);
    if (!match) { findings.push('Unparseable Model line'); return []; }
    return [{ bot: 'unknown', model: match[1] }];
  });
}

export function parseBuiltBy(input) {
  try {
    const { body = '', labels = [], commits = [], routing } = input;
    validateRouting(routing);
    if (typeof body !== 'string' || !Array.isArray(labels) || !Array.isArray(commits)) {
      throw new Error('Invalid parser input');
    }
    const findings = [];
    const bodyBuilders = readTags(body, findings);
    const trailerBuilders = [];
    const commitEntries = [];
    for (const commit of commits) {
      if (!record(commit) || typeof commit.message !== 'string') throw new Error('Invalid commit');
      // Only Built-by commit metadata is supported; legacy Model is body-only.
      if (/^\s*Built-by:/im.test(commit.message)) {
        const tags = readTags(commit.message, findings);
        trailerBuilders.push(...tags);
        commitEntries.push(...tags);
      } else commitEntries.push(...bodyBuilders);
    }
    let conflict = false;
    if (trailerBuilders.length && bodyBuilders.length) {
      // Trailers can cover only some commits. Each must appear in the body's
      // declared builder history, in order; otherwise the two claims conflict.
      let cursor = 0;
      for (const builder of trailerBuilders) {
        const index = bodyBuilders.findIndex((entry, i) => i >= cursor && entry.model === builder.model);
        if (index < 0) { conflict = true; break; }
        cursor = index; // repeated commits by the same builder are valid
      }
      if (conflict) findings.push('Commit trailer model disagrees with body');
    }
    // Walk commits in caller-supplied commit order, using body history only
    // for commits lacking a trailer. Adjacent identical builders collapse.
    const entries = commits.length ? commitEntries : bodyBuilders;
    const builders = entries.map(entry => {
      const id = entry.model.slice('model:'.length);
      const family = own(routing.pools, id) ? routing.pools[id].family : 'unknown';
      const bot = routing.bots.find(bot => bot.id === entry.bot);
      if (!bot) findings.push(`Unknown bot: ${entry.bot}`);
      else if (!bot.may_build) findings.push(`Bot may not build: ${entry.bot}`);
      if (family === 'unknown') findings.push(`Unknown model: ${entry.model}`);
      return { ...entry, family };
    }).filter((entry, index, all) => index === 0 ||
      entry.bot !== all[index - 1].bot || entry.model !== all[index - 1].model);
    const modelLabels = labels.map(label => typeof label === 'string' ? label : label?.name)
      .filter(label => typeof label === 'string' && label.startsWith('model:'));
    if (builders.length === 1 && modelLabels.length > 1) findings.push('Multiple model labels on single-builder PR');
    for (const label of modelLabels) {
      if (!own(routing.pools, label.slice(6))) findings.push(`Unknown model label: ${label}`);
      if (bodyBuilders.length && !bodyBuilders.some(builder => builder.model === label)) {
        conflict = true;
        findings.push(`Model label disagrees with body: ${label}`);
      }
    }
    const mixed = new Set(builders.map(builder => builder.family)).size > 1;
    const status = conflict ? 'conflict' : findings.length ? 'unknown' : mixed ? 'mixed' : builders.length ? 'ok' : 'missing';
    return { builders, status, findings: [...new Set(findings)] };
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
