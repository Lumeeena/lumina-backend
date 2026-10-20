/**
 * The id of a claimable balance created by an operation.
 *
 * Horizon's `create_claimable_balance` operation record does not carry the
 * balance id (only the `claimable_balance_created` effect and the later
 * `claim_claimable_balance` operation do), so it has to be derived. Stellar
 * Core defines it as the SHA-256 of an `ENVELOPE_TYPE_OP_ID` preimage built
 * from the transaction's source account, the sequence number it consumed and
 * the operation's 0-based position in the transaction, wrapped as a v0
 * `ClaimableBalanceID` (hence Horizon's `00000000` prefix).
 *
 * Checked against balance ids Horizon reports for mainnet operations; see
 * claimableBalanceId.test.ts.
 */
import { hash, Keypair, xdr } from '@stellar/stellar-sdk';

/**
 * The operation's 0-based index within its transaction.
 *
 * A Horizon operation id is a TOID: `ledger << 32 | txOrder << 12 | opIndex`,
 * where `opIndex` counts from 1.
 */
export function operationIndex(operationId: string): number {
  return Number(BigInt(operationId) & 0xfffn) - 1;
}

/**
 * Horizon's hex form of the claimable balance id that operation `operationId`
 * created in a transaction from `sourceAccount` consuming `sequence`.
 *
 * `sourceAccount` is the transaction's (inner) source `G...` address: for a
 * fee-bump, the inner transaction's, which is what Horizon reports as
 * `source_account`.
 */
export function claimableBalanceId(sourceAccount: string, sequence: string, operationId: string): string {
  const preimage = xdr.HashIdPreimage.envelopeTypeOpId(
    new xdr.HashIdPreimageOperationId({
      sourceAccount: Keypair.fromPublicKey(sourceAccount).xdrAccountId(),
      seqNum: xdr.Int64.fromString(sequence),
      opNum: operationIndex(operationId),
    })
  );
  return xdr.ClaimableBalanceId.claimableBalanceIdTypeV0(hash(preimage.toXDR())).toXDR('hex');
}
