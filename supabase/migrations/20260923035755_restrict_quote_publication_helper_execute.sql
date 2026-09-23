-- This SECURITY DEFINER helper is only called by the verified-internal-user
-- api_publish_quote_package function. It must not be a direct Data API RPC.
revoke execute on function public.insert_published_quote_option(
  uuid, public.client_option_kind, uuid, integer, numeric, numeric, text, uuid
) from public, anon, authenticated, service_role;
