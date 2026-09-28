import { GraphQLError } from 'graphql';

export const MAX_PAGE_SIZE = 100;

export function getPageSize(limit: number | null | undefined, defaultLimit = 20): number {
  const pageSize = limit ?? defaultLimit;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1) {
    throw new GraphQLError(`Page size must be a positive integer; received ${pageSize}.`, {
      extensions: { code: 'BAD_USER_INPUT' },
    });
  }
  if (pageSize > MAX_PAGE_SIZE) {
    throw new GraphQLError(
      `Requested page size ${pageSize} exceeds the maximum of ${MAX_PAGE_SIZE}.`,
      { extensions: { code: 'BAD_USER_INPUT' } }
    );
  }
  return pageSize;
}
