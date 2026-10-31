import { execFileSync } from "node:child_process";
import { findPsql } from "../../scripts/seed-dev.mjs";

// Only the standard disposable CI database. Never consume remote URLs or credentials.
const LOCAL_DB = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** Reuse seed-dev's synthetic extraction and published-offer path on this run's uploaded part. */
export function seedFriendsReleasePart(jobId) {
  if (!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(jobId)) {
    throw new Error("Expected the newly uploaded job UUID");
  }
  const psql = findPsql({});
  if (!psql) throw new Error("Local journey requires psql, as does npm run seed:dev");
  const tables = [
    ["drawing_extractions", [543]],
    ["approved_part_requirements", [553]],
    ["quote_runs", [602]],
    ["vendor_quote_results", [704, 705]],
    ["vendor_quote_offers", [804, 805]],
    ["published_quote_packages", [900]],
    ["published_quote_options", [910, 911]],
  ];
  const sourceIds = tables.flatMap(([, ids]) => ids.map(uuid));
  const statements = tables.map(([table, ids]) => `
    FOR source_row IN SELECT to_jsonb(t) FROM public.${table} t
      WHERE id IN (${ids.map((id) => `'${uuid(id)}'`).join(",")}) LOOP
      next_row := source_row;
      FOR field IN SELECT key FROM jsonb_each(source_row) LOOP
        IF mapping ? (source_row->>field) THEN
          next_row := jsonb_set(next_row, ARRAY[field], mapping->(source_row->>field));
        END IF;
      END LOOP;
      next_row := next_row || jsonb_build_object('created_at', now(), 'updated_at', now());
      IF '${table}' = 'approved_part_requirements' THEN
        next_row := next_row || jsonb_build_object('quote_quantities', jsonb_build_array(25), 'requested_by_date', null);
      ELSIF '${table}' = 'vendor_quote_results' THEN
        next_row := next_row || jsonb_build_object('raw_payload', jsonb_build_object('mode', 'simulate'),
          'quote_url', 'simulated://friends-release/' || (next_row->>'id'));
      ELSIF '${table}' = 'vendor_quote_offers' THEN
        next_row := next_row || jsonb_build_object('geographic_origin',
          CASE WHEN source_row->>'id' = '${uuid(804)}' THEN 'domestic' ELSE 'foreign' END,
          'sourcing', CASE WHEN source_row->>'id' = '${uuid(804)}' THEN 'USA' ELSE 'International' END,
          'quote_date', current_date, 'valid_until', current_date + 30, 'ship_receive_by', null,
          'raw_payload', jsonb_build_object('mode', 'simulate'));
      ELSIF '${table}' = 'published_quote_options' THEN
        next_row := next_row || jsonb_build_object('label',
          CASE WHEN source_row->>'id' = '${uuid(910)}' THEN 'Fixture US' ELSE 'Fixture INTL' END);
      END IF;
      INSERT INTO public.${table} SELECT * FROM jsonb_populate_record(null::public.${table}, next_row);
      copied := copied + 1;
    END LOOP;`).join("\n");

  execFileSync(psql, [LOCAL_DB, "-X", "-q", "-v", "ON_ERROR_STOP=1"], {
    timeout: 15_000,
    stdio: ["pipe", "pipe", "pipe"],
    input: `BEGIN;
      SET LOCAL statement_timeout = '10s';
      DO $fixture$
      DECLARE mapping jsonb; source_row jsonb; next_row jsonb; field text; part_id uuid; copied int := 0;
      BEGIN
        SELECT p.id INTO STRICT part_id FROM public.parts p JOIN public.jobs j ON j.id = p.job_id
          WHERE j.id = '${jobId}' AND j.organization_id = '${uuid(1)}'
          AND j.title = '1093-05589-02' AND j.created_at > now() - interval '10 minutes'
          AND p.cad_file_id IS NOT NULL AND p.drawing_file_id IS NOT NULL;
        IF EXISTS (SELECT 1 FROM public.quote_runs WHERE job_id = '${jobId}') THEN
          RAISE EXCEPTION 'Fixture target already has quote data';
        END IF;
        UPDATE public.parts SET quantity = 25 WHERE id = part_id;
        UPDATE public.jobs SET requested_quote_quantities = ARRAY[25], requested_by_date = null WHERE id = '${jobId}';
        SELECT jsonb_object_agg(id, gen_random_uuid()) INTO mapping
          FROM unnest(ARRAY[${sourceIds.map((id) => `'${id}'`).join(",")}]) id;
        mapping := mapping || jsonb_build_object('${uuid(103)}', '${jobId}', '${uuid(203)}', part_id);
        ${statements}
        IF copied <> ${sourceIds.length} THEN RAISE EXCEPTION 'Run npm run seed:dev first'; END IF;
      END $fixture$;
      COMMIT;`,
  });
}
