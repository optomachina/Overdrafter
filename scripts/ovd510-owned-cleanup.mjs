/** Reconcile exact attempted names even when Docker lost the creation reply. */
export function cleanupOwnedResource({ call, kind, name, fixtureId, attempted, previous = "not_created" }) {
  if (!attempted) return previous;
  const network = kind === "network";
  const inspected = call([...(network ? ["network"] : []), "inspect", "--format",
    network ? '{{ index .Labels "overdrafter.fixture-id" }}' : '{{ index .Config.Labels "overdrafter.fixture-id" }}', name],
  { allowFailure: true, allowAfterDeadline: true });
  if (inspected.error) return "unproved";
  if (inspected.status !== 0) {
    return /No such (object|container|network)/i.test(inspected.stderr ?? "")
      ? (previous === "removed_owned" ? previous : "absent_after_attempt") : "unproved";
  }
  if (inspected.stdout.trim() !== fixtureId) return "ownership_mismatch";
  const removed = call(network ? ["network", "rm", name] : ["rm", "--force", name],
    { allowFailure: true, allowAfterDeadline: true });
  return !removed.error && removed.status === 0 ? "removed_owned" : "remove_failed";
}
