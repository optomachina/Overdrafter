-- OVD-539: these SECURITY DEFINER status writers are internal helpers, not
-- client RPCs. Their owning trigger functions can still call them after the
-- exposed Data API roles lose direct EXECUTE permission.

revoke execute on function public.sync_quote_request_status_for_run(uuid, text)
from public, anon, authenticated;
revoke execute on function public.sync_service_request_line_item_status(uuid)
from public, anon, authenticated;

-- Server-side quote operations may call these exact helpers directly. Their
-- database owner retains implicit EXECUTE regardless of these grants.
grant execute on function public.sync_quote_request_status_for_run(uuid, text)
to service_role;
grant execute on function public.sync_service_request_line_item_status(uuid)
to service_role;
