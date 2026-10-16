-- OVD-837 smoke check, read only. The OVD-813 sanity-gate history read
-- (worker/src/fixtureHeal/sanityHistory.ts, createSupabaseSanityHistoryReader)
-- as plain SQL, keyed by the seeded "Fixture bracket A" package and requirement
-- at quantity 1. Own history (xometry, 90 days) and peers (other suppliers,
-- 30 days) are the two reads the worker makes; union all keeps both in one
-- statement. Expect > 0 rows on seeded staging (4 with the current seed).
select 'own' as read, vendor, unit_price_usd,
  raw_payload -> 'fixtureSanity' ->> 'cheapestUnitUsd' as cheapest_unit_usd, created_at
from public.vendor_quote_results
where requested_quantity = 1
  and status in ('instant_quote_received', 'official_quote_received')
  and vendor = 'xometry'
  and created_at >= now() - interval '90 days'
  and raw_payload -> 'fixtureSanity' ->> 'packageId' = '72ec5db52d4ceedb5fe0c5307532cf276f420f967a4ddd3399fa7a8772e703c3'
  and raw_payload -> 'fixtureSanity' ->> 'requirementKey' = '5c3214c2161433cf4d41c94986a49465856df6d942b24208b3da6908c4039ac0'
union all
select 'peer' as read, vendor, unit_price_usd,
  raw_payload -> 'fixtureSanity' ->> 'cheapestUnitUsd' as cheapest_unit_usd, created_at
from public.vendor_quote_results
where requested_quantity = 1
  and status in ('instant_quote_received', 'official_quote_received')
  and vendor <> 'xometry'
  and created_at >= now() - interval '30 days'
  and raw_payload -> 'fixtureSanity' ->> 'packageId' = '72ec5db52d4ceedb5fe0c5307532cf276f420f967a4ddd3399fa7a8772e703c3'
  and raw_payload -> 'fixtureSanity' ->> 'requirementKey' = '5c3214c2161433cf4d41c94986a49465856df6d942b24208b3da6908c4039ac0'
order by read, created_at desc
limit 50;
