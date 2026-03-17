export function shouldShowExtractionLauncher(input: {
  membershipRole: string | null | undefined;
  diagnosticsEnabled: boolean;
  isDev: boolean;
}) {
  return (
    (Boolean(input.membershipRole) && input.membershipRole !== "client") ||
    input.diagnosticsEnabled ||
    input.isDev
  );
}
