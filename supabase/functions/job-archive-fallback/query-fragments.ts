type SqlTag<TFragment> = (strings: TemplateStringsArray, ...values: unknown[]) => TFragment;

type SqlArrayBuilder<TArray> = (values: string[], type: string) => TArray;

export function buildBlobOwnershipExclusionClause<TFragment, TArray>(
  sqlTag: SqlTag<TFragment>,
  arrayBuilder: SqlArrayBuilder<TArray>,
  orphanBlobIds: string[],
): TFragment {
  if (orphanBlobIds.length === 0) {
    return sqlTag``;
  }

  return sqlTag`
    and not (blob.id = any(${arrayBuilder(orphanBlobIds, "uuid")}))
  `;
}
