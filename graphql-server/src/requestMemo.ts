/**
 * Request-level query execution memoization.
 *
 * DataLoader batches across resolvers for N+1 entity lookups, but does not
 * deduplicate identical top-level queries in a single GraphQL document — such
 * as a UI composing multiple panels that independently query the same dataset
 * (e.g. recent transactions or latest ledger).
 *
 * This memoizer caches in-flight and completed query executions keyed by
 * field name and canonical arguments, scoped strictly to the current request's
 * execution context. Nothing is shared across requests. Issue #289.
 */

export function canonicalSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalSerialize).join(',')}]`;
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const entries = keys.map(
    k => `${JSON.stringify(k)}:${canonicalSerialize((value as Record<string, unknown>)[k])}`
  );
  return `{${entries.join(',')}}`;
}

export function memoizeRequestQuery<T>(
  queryMemo: Map<string, Promise<unknown>> | undefined,
  queryName: string,
  args: unknown,
  execute: () => Promise<T>
): Promise<T> {
  if (!queryMemo) {
    return execute();
  }
  const key = `${queryName}:${canonicalSerialize(args)}`;
  const existing = queryMemo.get(key);
  if (existing) {
    return existing as Promise<T>;
  }
  const promise = execute();
  queryMemo.set(key, promise);
  return promise;
}
