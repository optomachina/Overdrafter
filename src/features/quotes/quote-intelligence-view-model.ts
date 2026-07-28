import { getClientItemPresentation } from "@/features/quotes/client-presentation";
import type { JobPartSummary, JobRecord } from "@/features/quotes/types";

const DISPLAY_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const DISPLAY_CODE_LENGTH = 6;

export type QuoteIntelligenceJob = Pick<
  JobRecord,
  | "id"
  | "title"
  | "description"
  | "status"
  | "tags"
  | "requested_service_kinds"
  | "primary_service_kind"
  | "created_at"
  | "updated_at"
>;

export type QuoteIntelligenceSummary = Pick<
  JobPartSummary,
  | "partNumber"
  | "revision"
  | "description"
  | "quantity"
  | "requestedQuoteQuantities"
  | "requestedByDate"
  | "requestedServiceKinds"
  | "primaryServiceKind"
  | "serviceNotes"
  | "selectedSupplier"
  | "selectedPriceUsd"
>;

export type QuoteIntelligenceProject = {
  id: string;
  name: string;
  partCount?: number;
  updatedAt?: string | null;
};

export type QuoteIntelligenceMetadata = {
  material: string | null;
  finish: string | null;
  process: string | null;
  threads: string | null;
  tightestToleranceInch: number | null;
  fileNames: string[];
};

export type QuoteIntelligenceFacts = {
  offerCount: number;
  requestedAt: string | null;
};

export type EngineeringQueryChip = {
  id: string;
  kind: "diameter" | "measurement";
  label: string;
  value: number;
  unit: "mm" | "cm" | "m" | "in" | "thou";
};

export type ParsedEngineeringQuery = {
  raw: string;
  normalized: string;
  tokens: string[];
  chips: EngineeringQueryChip[];
};

type SearchField = {
  label: string;
  value: string;
  weight: number;
  revealValue?: boolean;
};

export type MatchExplanation = {
  label: string;
  value?: string;
};

type SearchableItem = {
  searchFields: SearchField[];
  matchScore: number;
  matchExplanations: MatchExplanation[];
};

export type PartCollectionItem = SearchableItem & {
  id: string;
  kind: "part" | "project_group";
  title: string;
  description: string;
  href: string;
  statusLabel: string;
  reference: string | null;
  revision: string | null;
  quantity: number | null;
  tags: string[];
  services: string[];
  projectNames: string[];
  partCount: number | null;
  updatedAt: string | null;
  material: string | null;
  finish: string | null;
  process: string | null;
};

export type PartCollectionFilter = "all" | "parts" | "assemblies";

export type QuoteCollectionItem = SearchableItem & {
  id: string;
  legacyJobId: string;
  displayCode: string;
  title: string;
  description: string;
  reference: string | null;
  partReference: string | null;
  stateLabel: string;
  offerCount: number | null;
  selectedSupplier: string | null;
  selectedPriceUsd: number | null;
  requestedAt: string | null;
  requestedByDate: string | null;
  updatedAt: string;
  projectNames: string[];
};

export type GlobalSearchResult =
  | { kind: "part"; id: string; title: string; context: string; href: string; explanations: MatchExplanation[] }
  | { kind: "project"; id: string; title: string; context: string; href: string; explanations: MatchExplanation[] }
  | { kind: "quote"; id: string; title: string; context: string; href: string; explanations: MatchExplanation[] };

function normalizeSearchText(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[øØ⌀]/g, " diameter ")
    .replace(/\bdia(?:meter)?\.?\b/g, " diameter ")
    .replace(/\bmillimet(?:er|re)s?\b/g, " mm ")
    .replace(/\bcentimet(?:er|re)s?\b/g, " cm ")
    .replace(/\bmet(?:er|re)s?\b/g, " m ")
    .replace(/\b(?:inches|inch)\b/g, " in ")
    .replace(/\b(?:mils?|thousandths?)\b/g, " thou ")
    .replace(/(\d)\s*"/g, "$1 in ")
    .replace(/(\d|\.)\s*(mm|cm|thou|in)\b/g, "$1 $2")
    .replace(/((?:\d+(?:\.\d+)?|\.\d+))\s+diameter\s+(mm|cm|m|in|thou)\b/g, "diameter $1 $2")
    .replace(/((?:\d+(?:\.\d+)?|\.\d+))\s+diameter\b/g, "diameter $1 in")
    .replace(
      /\bdiameter\s+((?:\d+(?:\.\d+)?|\.\d+))(?![\d.])(?!\s*(?:mm|cm|m|in|thou)\b)/g,
      "diameter $1 in",
    )
    .replace(/[,:;=()[\]{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function formatMeasurement(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(4)));
}

/**
 * Parses only explicit engineering aliases and explicit units from user-entered text.
 * It never reads or invents part geometry.
 */
export function parseEngineeringQuery(raw: string): ParsedEngineeringQuery {
  const normalized = normalizeSearchText(raw);
  const chips: EngineeringQueryChip[] = [];
  const coveredMeasurements = new Set<string>();
  const numberPattern = "(?:\\d+(?:\\.\\d+)?|\\.\\d+)";
  const diameterPattern = new RegExp(`\\bdiameter\\s*(${numberPattern})\\s*(mm|cm|m|in|thou)\\b`, "g");
  const measurementPattern = new RegExp(`\\b(${numberPattern})\\s*(mm|cm|m|in|thou)\\b`, "g");

  for (const match of normalized.matchAll(diameterPattern)) {
    const value = Number(match[1]);
    const unit = match[2] as EngineeringQueryChip["unit"];

    if (Number.isFinite(value)) {
      const measurementKey = `${value}:${unit}`;
      coveredMeasurements.add(measurementKey);
      chips.push({
        id: `diameter:${measurementKey}`,
        kind: "diameter",
        label: `Diameter ${formatMeasurement(value)} ${unit}`,
        value,
        unit,
      });
    }
  }

  for (const match of normalized.matchAll(measurementPattern)) {
    const value = Number(match[1]);
    const unit = match[2] as EngineeringQueryChip["unit"];
    const measurementKey = `${value}:${unit}`;

    if (Number.isFinite(value) && !coveredMeasurements.has(measurementKey)) {
      chips.push({
        id: `measurement:${measurementKey}`,
        kind: "measurement",
        label: `${formatMeasurement(value)} ${unit}`,
        value,
        unit,
      });
    }
  }

  return {
    raw,
    normalized,
    tokens: Array.from(new Set(normalized.split(" ").filter(Boolean))),
    chips,
  };
}

/** Builds a stable, non-sequential six-character display locator from an existing access-filtered ID. */
export function createQuoteDisplayCode(stableId: string): string {
  let hash = 0x811c9dc5;

  for (let index = 0; index < stableId.length; index += 1) {
    hash ^= stableId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  hash ^= hash >>> 16;
  let code = "";

  for (let index = 0; index < DISPLAY_CODE_LENGTH; index += 1) {
    const alphabetIndex = (hash >>> 0) % DISPLAY_CODE_ALPHABET.length;
    code += DISPLAY_CODE_ALPHABET[alphabetIndex];
    hash = Math.imul(hash ^ (hash >>> 13), 0x5bd1e995);
  }

  return code;
}

export function buildAppAwareHref(href: string, appMode?: "ios" | null): string {
  if (appMode !== "ios") {
    return href;
  }

  const [pathAndQuery, fragment] = href.split("#", 2);
  const [pathname, query = ""] = pathAndQuery.split("?", 2);
  const searchParams = new URLSearchParams(query);
  searchParams.set("app", "ios");
  const nextHref = `${pathname}?${searchParams.toString()}`;
  return fragment ? `${nextHref}#${fragment}` : nextHref;
}

export function buildQuoteDetailHref(displayCode: string, appMode?: "ios" | null): string {
  return buildAppAwareHref(`/quotes/${displayCode}`, appMode);
}

function matchSearchFields(
  searchFields: SearchField[],
  query: ParsedEngineeringQuery,
): Pick<SearchableItem, "matchScore" | "matchExplanations"> | null {
  if (query.tokens.length === 0) {
    return { matchScore: 0, matchExplanations: [] };
  }

  const normalizedFields = searchFields.map((field) => ({
    ...field,
    normalizedValue: normalizeSearchText(field.value),
  }));
  const matchedFields = new Set<number>();
  let matchScore = 0;

  for (const token of query.tokens) {
    const matches = normalizedFields
      .map((field, index) => ({ field, index }))
      .filter(({ field }) => field.normalizedValue.includes(token));

    if (matches.length === 0) {
      return null;
    }

    matchScore += Math.max(...matches.map(({ field }) => field.weight));
    matches.forEach(({ index }) => matchedFields.add(index));
  }

  const explanations = Array.from(matchedFields)
    .sort((left, right) => normalizedFields[right].weight - normalizedFields[left].weight)
    .map((index) => normalizedFields[index])
    .filter((field, index, fields) => fields.findIndex((candidate) => candidate.label === field.label) === index)
    .slice(0, 2)
    .map((field) => ({
      label: `${field.label} match`,
      value: field.revealValue ? field.value : undefined,
    }));

  return { matchScore, matchExplanations: explanations };
}

function jobStateLabel(status: JobRecord["status"]): string {
  switch (status) {
    case "uploaded":
      return "Uploaded";
    case "extracting":
      return "Extracting";
    case "needs_spec_review":
      return "Needs specification review";
    case "ready_to_quote":
      return "Ready to request";
    case "quoting":
      return "Request in progress";
    case "awaiting_vendor_manual_review":
      return "Supplier review";
    case "internal_review":
      return "Reviewing offers";
    case "published":
      return "Offers available";
    case "client_selected":
      return "Offer selected";
    case "closed":
      return "Closed";
  }
}

function projectNamesForJob(
  jobId: string,
  projectsById: ReadonlyMap<string, QuoteIntelligenceProject>,
  projectIdsByJobId: ReadonlyMap<string, readonly string[]>,
): string[] {
  return (projectIdsByJobId.get(jobId) ?? [])
    .map((projectId) => projectsById.get(projectId)?.name)
    .filter((name): name is string => Boolean(name));
}

export function buildPartCollection({
  jobs,
  summariesByJobId,
  projects = [],
  projectIdsByJobId = new Map(),
  metadataByJobId = new Map(),
  appMode = null,
}: {
  jobs: readonly QuoteIntelligenceJob[];
  summariesByJobId: ReadonlyMap<string, QuoteIntelligenceSummary>;
  projects?: readonly QuoteIntelligenceProject[];
  projectIdsByJobId?: ReadonlyMap<string, readonly string[]>;
  metadataByJobId?: ReadonlyMap<string, QuoteIntelligenceMetadata>;
  appMode?: "ios" | null;
}): PartCollectionItem[] {
  const projectsById = new Map(projects.map((project) => [project.id, project]));
  const projectRows: PartCollectionItem[] = projects.map((project) => ({
    id: project.id,
    kind: "project_group",
    title: project.name,
    description: "Project-backed part grouping",
    href: buildAppAwareHref(`/projects/${project.id}`, appMode),
    statusLabel: "Project group",
    reference: null,
    revision: null,
    quantity: null,
    tags: [],
    services: [],
    projectNames: [],
    partCount:
      project.partCount ??
      jobs.filter((job) => (projectIdsByJobId.get(job.id) ?? []).includes(project.id)).length,
    updatedAt: project.updatedAt ?? null,
    material: null,
    finish: null,
    process: null,
    searchFields: [{ label: "Project", value: project.name, weight: 9, revealValue: true }],
    matchScore: 0,
    matchExplanations: [],
  }));
  const partRows = jobs.map((job): PartCollectionItem => {
    const summary = summariesByJobId.get(job.id);
    const presentation = getClientItemPresentation(job, summary);
    const projectNames = projectNamesForJob(job.id, projectsById, projectIdsByJobId);
    const services = Array.from(
      new Set([
        ...job.requested_service_kinds,
        ...(summary?.requestedServiceKinds ?? []),
        job.primary_service_kind ?? "",
        summary?.primaryServiceKind ?? "",
      ].filter(Boolean)),
    );
    const reference = summary?.partNumber ?? presentation.partNumber;
    const description = summary?.description ?? presentation.description;
    const metadata = metadataByJobId.get(job.id);
    const tolerance =
      metadata?.tightestToleranceInch === null || metadata?.tightestToleranceInch === undefined
        ? ""
        : `${metadata.tightestToleranceInch} in tolerance`;

    return {
      id: job.id,
      kind: "part",
      title: presentation.title,
      description,
      href: buildAppAwareHref(`/parts/${job.id}`, appMode),
      statusLabel: jobStateLabel(job.status),
      reference,
      revision: summary?.revision ?? null,
      quantity: summary?.quantity ?? null,
      tags: job.tags,
      services,
      projectNames,
      partCount: null,
      updatedAt: job.updated_at,
      material: metadata?.material ?? null,
      finish: metadata?.finish ?? null,
      process: metadata?.process ?? null,
      searchFields: [
        { label: "Title", value: presentation.title, weight: 10, revealValue: true },
        { label: "Part reference", value: [reference, summary?.revision].filter(Boolean).join(" "), weight: 10, revealValue: true },
        { label: "Description", value: description, weight: 6 },
        { label: "Tag", value: job.tags.join(" "), weight: 8, revealValue: true },
        { label: "Service", value: services.join(" "), weight: 7, revealValue: true },
        { label: "Project", value: projectNames.join(" "), weight: 5, revealValue: true },
        { label: "Request details", value: summary?.serviceNotes ?? "", weight: 4 },
        { label: "Material", value: metadata?.material ?? "", weight: 9, revealValue: true },
        { label: "Finish", value: metadata?.finish ?? "", weight: 9, revealValue: true },
        { label: "Process", value: metadata?.process ?? "", weight: 8, revealValue: true },
        { label: "Thread", value: metadata?.threads ?? "", weight: 9, revealValue: true },
        { label: "Tolerance", value: tolerance, weight: 8, revealValue: true },
        { label: "Filename", value: metadata?.fileNames.join(" ") ?? "", weight: 6, revealValue: true },
      ],
      matchScore: 0,
      matchExplanations: [],
    };
  });

  return [...projectRows, ...partRows];
}

export function filterPartCollection(
  items: readonly PartCollectionItem[],
  filter: PartCollectionFilter,
  query: ParsedEngineeringQuery,
): PartCollectionItem[] {
  if (filter === "assemblies") {
    return [];
  }

  return items
    .filter((item) => filter === "all" || item.kind === "part")
    .map((item) => {
      const match = matchSearchFields(item.searchFields, query);
      return match ? { ...item, ...match } : null;
    })
    .filter((item): item is PartCollectionItem => Boolean(item))
    .sort((left, right) => right.matchScore - left.matchScore || left.title.localeCompare(right.title));
}

export function buildQuoteCollection({
  jobs,
  summariesByJobId,
  projects = [],
  projectIdsByJobId = new Map(),
  referencesByJobId = new Map(),
  metadataByJobId = new Map(),
  factsByJobId = new Map(),
}: {
  jobs: readonly QuoteIntelligenceJob[];
  summariesByJobId: ReadonlyMap<string, QuoteIntelligenceSummary>;
  projects?: readonly QuoteIntelligenceProject[];
  projectIdsByJobId?: ReadonlyMap<string, readonly string[]>;
  referencesByJobId?: ReadonlyMap<string, string>;
  metadataByJobId?: ReadonlyMap<string, QuoteIntelligenceMetadata>;
  factsByJobId?: ReadonlyMap<string, QuoteIntelligenceFacts>;
}): QuoteCollectionItem[] {
  const projectsById = new Map(projects.map((project) => [project.id, project]));

  return jobs
    .map((job): QuoteCollectionItem => {
      const summary = summariesByJobId.get(job.id);
      const presentation = getClientItemPresentation(job, summary);
      const projectNames = projectNamesForJob(job.id, projectsById, projectIdsByJobId);
      const displayCode = createQuoteDisplayCode(job.id);
      const reference = referencesByJobId.get(job.id) ?? null;
      const stateLabel = jobStateLabel(job.status);
      const metadata = metadataByJobId.get(job.id);
      const facts = factsByJobId.get(job.id);
      const tolerance =
        metadata?.tightestToleranceInch === null || metadata?.tightestToleranceInch === undefined
          ? ""
          : `${metadata.tightestToleranceInch} in tolerance`;

      return {
        id: displayCode,
        legacyJobId: job.id,
        displayCode,
        title: presentation.title,
        description: summary?.description ?? presentation.description,
        reference,
        partReference: summary?.partNumber ?? presentation.partNumber,
        stateLabel,
        offerCount: facts?.offerCount ?? null,
        selectedSupplier: summary?.selectedSupplier ?? null,
        selectedPriceUsd: summary?.selectedPriceUsd ?? null,
        requestedAt: facts?.requestedAt ?? null,
        requestedByDate: summary?.requestedByDate ?? null,
        updatedAt: job.updated_at,
        projectNames,
        searchFields: [
          { label: "Quote code", value: displayCode, weight: 12, revealValue: true },
          { label: "Title", value: presentation.title, weight: 10, revealValue: true },
          { label: "Reference", value: reference ?? "", weight: 11, revealValue: true },
          { label: "Part reference", value: summary?.partNumber ?? "", weight: 9, revealValue: true },
          { label: "State", value: stateLabel, weight: 6, revealValue: true },
          { label: "Project", value: projectNames.join(" "), weight: 5, revealValue: true },
          { label: "Description", value: summary?.description ?? presentation.description, weight: 4 },
          { label: "Supplier", value: summary?.selectedSupplier ?? "", weight: 3 },
          { label: "Material", value: metadata?.material ?? "", weight: 9, revealValue: true },
          { label: "Finish", value: metadata?.finish ?? "", weight: 9, revealValue: true },
          { label: "Process", value: metadata?.process ?? "", weight: 8, revealValue: true },
          { label: "Thread", value: metadata?.threads ?? "", weight: 9, revealValue: true },
          { label: "Tolerance", value: tolerance, weight: 8, revealValue: true },
          { label: "Filename", value: metadata?.fileNames.join(" ") ?? "", weight: 6, revealValue: true },
        ],
        matchScore: 0,
        matchExplanations: [],
      };
    })
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
}

export function filterQuoteCollection(
  items: readonly QuoteCollectionItem[],
  query: ParsedEngineeringQuery,
): QuoteCollectionItem[] {
  return items
    .map((item) => {
      const match = matchSearchFields(item.searchFields, query);
      return match ? { ...item, ...match } : null;
    })
    .filter((item): item is QuoteCollectionItem => Boolean(item))
    .sort((left, right) => right.matchScore - left.matchScore || Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
}

export function buildGlobalSearchResults({
  parts,
  quotes,
  query,
  appMode,
}: {
  parts: readonly PartCollectionItem[];
  quotes: readonly QuoteCollectionItem[];
  query: ParsedEngineeringQuery;
  appMode?: "ios" | null;
}): GlobalSearchResult[] {
  if (query.tokens.length === 0) {
    return [];
  }

  const matchedParts = filterPartCollection(parts, "all", query).map((item): GlobalSearchResult => ({
    kind: item.kind === "project_group" ? "project" : "part",
    id: item.id,
    title: item.title,
    context:
      item.kind === "project_group"
        ? `${item.partCount ?? 0} parts · project group`
        : [item.reference, item.projectNames.join(", ")].filter(Boolean).join(" · ") || item.statusLabel,
    href: buildAppAwareHref(item.href, appMode),
    explanations: item.matchExplanations,
  }));
  const matchedQuotes = filterQuoteCollection(quotes, query).map((item): GlobalSearchResult => ({
    kind: "quote",
    id: item.id,
    title: item.title,
    context: `${item.displayCode} · ${item.reference ?? item.stateLabel}`,
    href: buildQuoteDetailHref(item.displayCode, appMode),
    explanations: item.matchExplanations,
  }));

  return [...matchedParts, ...matchedQuotes];
}
