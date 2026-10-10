-- OVD-679, OVD-680, OVD-682, OVD-683: Allow org members to manage shipping/billing address and confirm sourcing destination

-- Create helper function to check if user is any member of organization
create or replace function public.is_org_member(p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.organization_memberships membership
    where membership.organization_id = p_organization_id
      and membership.user_id = auth.uid()
  );
$$;

-- Update organizations policy to allow org members to update billing/shipping fields
drop policy if exists "organizations_members_can_update_address" on public.organizations;
create policy "organizations_members_can_update_address"
on public.organizations
for update
to authenticated
using (public.is_org_member(id))
with check (public.is_org_member(id));

-- Update api_confirm_sourcing_destination to allow org members (not just org admins)
create or replace function public.api_confirm_sourcing_destination(
  p_organization_id uuid,
  p_expected_address jsonb
)
returns void
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_org public.organizations%rowtype;
  v_address jsonb;
begin
  perform public.require_verified_auth();
  if not public.is_org_member(p_organization_id) then
    raise exception 'sourcing_destination_access_denied';
  end if;
  select * into v_org from public.organizations where id = p_organization_id for update;
  -- Lock waits can outlive a membership or verified-auth revocation.
  perform public.require_verified_auth();
  if v_org.id is null or not public.is_org_member(p_organization_id) then
    raise exception 'sourcing_destination_access_denied';
  end if;
  v_address := private.sourcing_address_from_row(v_org);
  if p_expected_address is distinct from v_address then
    raise exception 'sourcing_destination_changed';
  end if;
  if not private.sourcing_address_complete(v_address) then
    raise exception 'sourcing_destination_incomplete';
  end if;
  update public.organizations
  set confirmed_sourcing_address_at = now()
  where id = p_organization_id;
end;
$$;

revoke all on function public.is_org_member(uuid) from public, anon, service_role;
grant execute on function public.is_org_member(uuid) to authenticated;
