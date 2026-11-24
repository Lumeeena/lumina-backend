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

/**
 * Serialize a value to a string that is the same for equal values, whatever
 * order their object keys were written in. Memo keys are built from it, so
 * `{ a: 1, b: 2 }` and `{ b: 2, a: 1 }` must land on the same entry.
 *
 * Array order is kept, because order is meaningful there. Values JSON cannot
 * express do not get a distinct key: `NaN` and `Infinity` become `null`, the
 * same as `null`, and a `Date` becomes `{}`. Memo arguments are GraphQL
 * inputs, and the schema declares no custom scalars, so every argument is
 * JSON-shaped and this does not arise today. An `undefined` value is not valid
 * JSON; it comes back as the text `undefined`, not a string, so callers should
 * not pass one.
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

/**
 * Run `execute` at most once per query name and argument set within one
 * request, and hand the same promise to every later caller.
 *
 * A caller that arrives while the first lookup is still in flight gets that
 * promise, so two panels asking for the same data share one round trip. Only
 * the promise is stored, so a failure is shared too: a lookup that rejects
 * rejects identically for the rest of the request rather than being retried.
 * With no `queryMemo` (a call made outside a request) it simply runs `execute`.
 *
 * `queryMemo` is created per request in `createContext`, which is what keeps
 * results from leaking across requests.
 */
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
