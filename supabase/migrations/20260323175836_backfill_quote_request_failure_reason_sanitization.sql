update public.quote_requests
set failure_reason = case
  when status <> 'failed' then null
  when nullif(trim(coalesce(failure_reason, '')), '') is null then null
  when trim(failure_reason) in (
    'Xometry could not return an automated quote and needs manual follow-up.',
    'Xometry quote collection failed before a usable response was received.',
    'Quote collection ended without a usable Xometry response.',
    'Quote collection did not return a usable Xometry response.'
  ) then trim(failure_reason)
  else 'Quote collection did not return a usable Xometry response.'
end
where failure_reason is not null;
