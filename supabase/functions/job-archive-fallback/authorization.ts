export type DirectJobAuthorizationInput = {
  createdByMatchesUser: boolean;
  isOrgMember: boolean;
  canEditDirectProject: boolean;
  canEditProjectViaJoinTable: boolean;
};

export function canUserEditJobWithoutAuthContext(input: DirectJobAuthorizationInput): boolean {
  return (
    input.createdByMatchesUser ||
    input.isOrgMember ||
    input.canEditDirectProject ||
    input.canEditProjectViaJoinTable
  );
}
