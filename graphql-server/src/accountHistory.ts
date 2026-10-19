/**
 * Historical account state, for `account(address:, asOfLedger:)`.
 *
 * What is answered, and how far back, is decided in docs/ACCOUNT_STATE_HISTORY.md.
 * In short: the indexer stores a copy of an account each time it refreshes that
 * account, keyed by the ledger Horizon reports as the state's last modification.
 * A query for ledger N returns the most recent copy at or before N. The copy is
 * exact as of its own ledger, but changes between two stored copies are not
 * visible, so the answer is a lower bound on how often the account changed.
 */

/**
 * A caller-facing error for a bad `asOfLedger`. Listed with the other deliberate
 * errors in errorMasking.ts so its message reaches the caller in production.
 */
export class AccountHistoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccountHistoryError';
  }
}

/** Checks an `asOfLedger` argument. Returns it unchanged when it is a valid ledger sequence. */
export function parseAsOfLedger(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new AccountHistoryError(`asOfLedger must be a ledger sequence of 1 or more, got ${value}`);
  }
  return value;
}
