/** Compare non-secret catalog descriptors before an owned SQL fixture is removed. */
export function catalogParityDiff(sourceRows, fixtureRows) {
  const group = (rows) => {
    const grouped = new Map();
    for (const row of rows) grouped.set(row.identity, [...(grouped.get(row.identity) ?? []), row]);
    for (const entries of grouped.values()) entries.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    return grouped;
  };
  const source = group(sourceRows);
  const fixture = group(fixtureRows);
  const differences = [];
  for (const identity of [...new Set([...source.keys(), ...fixture.keys()])].sort()) {
    const beforeEntries = source.get(identity) ?? [];
    const afterEntries = fixture.get(identity) ?? [];
    for (let ordinal = 0; ordinal < Math.max(beforeEntries.length, afterEntries.length); ordinal += 1) {
    const before = beforeEntries[ordinal];
    const after = afterEntries[ordinal];
    if (!before || !after) {
      differences.push({ identity, ordinal, kind: before ? "missing-in-fixture" : "extra-in-fixture",
        source: before ?? null, fixture: after ?? null });
      continue;
    }
    const fields = [...new Set([...Object.keys(before), ...Object.keys(after)])]
      .filter((key) => key !== "identity" && JSON.stringify(before[key] ?? null) !== JSON.stringify(after[key] ?? null))
      .sort();
    if (fields.length > 0) {
      differences.push({ identity, ordinal, kind: "changed", fields,
        source: Object.fromEntries(fields.map((key) => [key, before[key] ?? null])),
        fixture: Object.fromEntries(fields.map((key) => [key, after[key] ?? null])) });
    }
    }
  }
  return { sourceCount: sourceRows.length, fixtureCount: fixtureRows.length, differences };
}

/** Limit diagnostic retrieval without dropping catalog objects at the process buffer boundary. */
export function catalogPageQuery(query, offset, pageSize = 100) {
  const start = query.indexOf("from (");
  const end = query.lastIndexOf(") item;");
  if (start < 0 || end < start || !Number.isSafeInteger(offset) || offset < 0
    || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw new Error("invalid_catalog_page_query");
  }
  const inner = query.slice(start + "from (".length, end);
  return `select coalesce(json_agg(row_to_json(page) order by page.identity), '[]'::json)
    from (select * from (${inner}) item order by item.identity, row_to_json(item)::text
      limit ${pageSize} offset ${offset}) page;`;
}

/** Fetch complete descriptors in bounded pages, shrinking on a large response. */
export function fetchCatalogRows(query, executePage, maxRows = 100_000) {
  const rows = [];
  let pageSize = 100;
  for (let offset = 0; offset < maxRows;) {
    let batch;
    try {
      batch = executePage(catalogPageQuery(query, offset, pageSize), offset, pageSize);
    } catch (error) {
      if (pageSize === 1) {
        error.partialRows = rows;
        throw error;
      }
      pageSize = Math.max(1, Math.floor(pageSize / 2));
      continue;
    }
    if (!Array.isArray(batch) || batch.length > pageSize) {
      const error = new Error("invalid_catalog_page_response");
      error.partialRows = rows;
      throw error;
    }
    rows.push(...batch);
    if (batch.length < pageSize) return rows;
    offset += batch.length;
  }
  const error = new Error("catalog_diagnostic_row_limit_exceeded");
  error.partialRows = rows;
  throw error;
}

/** Preserve each failed category's diagnostic result even if another query fails. */
export function captureCatalogObjectDiffs(categories, queries, fetchRows) {
  const result = {};
  for (const name of categories) {
    let sourceRows = [];
    let fixtureRows = [];
    let interruptedSide = "source";
    try {
      if (!queries[name]) throw new Error("missing_catalog_descriptor_query");
      sourceRows = fetchRows(queries[name], true);
      interruptedSide = "fixture";
      fixtureRows = fetchRows(queries[name], false);
      result[name] = catalogParityDiff(sourceRows, fixtureRows);
    } catch (error) {
      const partial = error.partialRows ?? [];
      result[name] = { diagnosticError: "catalog_descriptor_capture_failed",
        interruptedSide, completeSourceRows: sourceRows, completeFixtureRows: fixtureRows,
        interruptedRows: partial };
    }
  }
  return result;
}
