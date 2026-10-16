-- OVD-837 smoke check, read only. The OVD-813 sanity-gate history read
-- (worker/src/fixtureHeal/sanityHistory.ts, createSupabaseSanityHistoryReader)
-- as plain SQL, keyed by the seeded "Fixture bracket A" package and requirement
-- at quantity 1. Own history (xometry, 90 days) and peers (other suppliers,
-- 30 days) are the two reads the worker makes; history_read keeps both in one
-- statement. Expect > 0 rows on seeded staging (4 with the current seed).
with history_read(read, own_vendor, window_days) as (values ('own', true, 90), ('peer', false, 30))
select history_read.read, result.vendor, result.unit_price_usd,
  result.raw_payload -> 'fixtureSanity' ->> 'cheapestUnitUsd' as cheapest_unit_usd, result.created_at
from history_read
join public.vendor_quote_results result
  on (result.vendor = 'xometry') = history_read.own_vendor
  and result.created_at >= now() - make_interval(days => history_read.window_days)
where result.requested_quantity = 1
  and result.status in ('instant_quote_received', 'official_quote_received')
  and result.raw_payload -> 'fixtureSanity' ->> 'packageId' = '72ec5db52d4ceedb5fe0c5307532cf276f420f967a4ddd3399fa7a8772e703c3'
  and result.raw_payload -> 'fixtureSanity' ->> 'requirementKey' = '5c3214c2161433cf4d41c94986a49465856df6d942b24208b3da6908c4039ac0'
order by history_read.read, result.created_at desc
limit 50;
