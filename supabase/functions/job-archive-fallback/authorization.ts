export type DirectJobAuthorizationInput = {
  createdByMatchesUser: boolean;
  isInternalAdmin: boolean;
  canEditDirectProject: boolean;
  canEditProjectViaJoinTable: boolean;
};

export function canUserDestructivelyEditJobWithoutAuthContext(
  input: DirectJobAuthorizationInput,
): boolean {
  return (
    input.createdByMatchesUser ||
    input.isInternalAdmin ||
    input.canEditDirectProject ||
    input.canEditProjectViaJoinTable
  );
}
