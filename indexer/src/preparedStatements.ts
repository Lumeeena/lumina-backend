/**
 * Names of the prepared statements on the indexer's hot write paths.
 *
 * A query sent with a `name` is parsed and planned once per connection, the
 * first time that connection runs it, and reused from then on. That is the
 * whole mechanism: `db.ts` names its hot statements with these constants, and
 * the statement text lives only there.
 *
 * There is deliberately no hook that prepares them when a connection opens.
 * `pg` can only prepare a statement by executing it, so a hook would run each
 * INSERT without its parameters, fail the bind, and stop after the first one;
 * and a second copy of the text is one whitespace edit away from a different
 * statement under the same name, which `pg` rejects on every later use. Both
 * happened: the hook registered its own copies at connect, and every ledger
 * write then failed with "Prepared statements must be unique".
 */

/** Names of prepared statements for hot paths */
export const PREPARED_STATEMENTS = {
  INSERT_LEDGER: 'insert_ledger',
  INSERT_TRANSACTION: 'insert_transaction',
  INSERT_OPERATION: 'insert_operation',
  UPSERT_ACCOUNT: 'upsert_account',
  INSERT_CONTRACT_EVENT: 'insert_contract_event',
} as const;
