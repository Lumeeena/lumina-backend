/**
 * Exact fixed-point arithmetic for Stellar asset amounts.
 *
 * A Stellar amount is an integer number of stroops, and every asset has seven
 * decimal places — so an amount is a bigint of stroops and nothing else. Doing
 * this with JS `number` is the trap: the largest valid amount is just under
 * 2^63 stroops, which is beyond the 2^53 a double represents exactly, so a
 * balance computed in floating point can come back off by a stroop and no
 * longer match the ledger it claims to describe.
 *
 * The same reasoning already keeps Soroban's i128 amounts as canonical decimal
 * strings elsewhere in this repo (see indexer/src/customDecode.ts): values that
 * do not fit a double are carried as text, never rounded. This is that idea
 * promoted to arithmetic.
 *
 * No exponent notation is accepted. Horizon reports amounts as plain decimal
 * strings, and silently interpreting `1e-7` differently from `0.0000001` would
 * be a rounding bug wearing a parsing costume.
 */

/** Stellar ledger amounts always have 7 decimal places (1 unit = 10^7 stroops). */
const SCALE = 7;
/** Multiplier converting whole units into integer stroops (10_000_000n). */
const SCALE_FACTOR = 10n ** BigInt(SCALE);

/** Only plain decimal: an optional sign, digits, and an optional fraction. */
const DECIMAL_TEXT = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;

/**
 * Immutable fixed-point Stellar asset amount backed by an integer `bigint`
 * stroop count. Avoids IEEE-754 double rounding for balances up to 2^63 - 1
 * stroops.
 */
export class StellarAmount {
  /** Value in stroops. The single source of truth; nothing is stored as a double. */
  private readonly stroops: bigint;

  private constructor(stroops: bigint) {
    this.stroops = stroops;
  }

  /** Zero-stroop amount constant. */
  static readonly ZERO = new StellarAmount(0n);

  /**
   * Parse an amount from a decimal string, a stroop count, or another amount.
   *
   * A JS `number` is deliberately not accepted. An amount is either decimal
   * text (what Horizon reports) or a whole number of stroops, and a double
   * cannot represent large stroop counts exactly — so accepting one would let a
   * caller skip past the very guarantee this class exists to provide.
   *
   * Throws on anything else rather than returning NaN: an unparseable amount in
   * a balance replay means the operation details are not what we assumed they
   * were, and a wrong number is far harder to notice than a failed request.
   */
  static from(value: string | bigint | StellarAmount): StellarAmount {
    if (value instanceof StellarAmount) return value;
    if (typeof value === 'bigint') return new StellarAmount(value);
    if (typeof value !== 'string') {
      throw new Error(`Invalid Stellar amount: ${String(value)}`);
    }

    const text = value.trim();
    if (!DECIMAL_TEXT.test(text)) {
      throw new Error(`Invalid Stellar amount: ${JSON.stringify(value)}`);
    }

    const negative = text.startsWith('-');
    const unsigned = text.replace(/^[+-]/, '');
    const [whole = '0', fraction = ''] = unsigned.split('.');

    if (fraction.length > SCALE) {
      throw new Error(
        `Stellar amount has more than ${SCALE} decimal places, which cannot exist on the ledger: ${text}`
      );
    }

    const stroops = BigInt(whole) * SCALE_FACTOR + BigInt(fraction.padEnd(SCALE, '0') || '0');
    return new StellarAmount(negative ? -stroops : stroops);
  }

  /** Return the sum of this amount and `other`. */
  plus(other: StellarAmount): StellarAmount {
    return new StellarAmount(this.stroops + other.stroops);
  }

  /** Return the difference `this - other`. */
  minus(other: StellarAmount): StellarAmount {
    return new StellarAmount(this.stroops - other.stroops);
  }

  /** Return true when both amounts represent the exact same stroop count. */
  equals(other: StellarAmount): boolean {
    return this.stroops === other.stroops;
  }

  /** True when this amount is greater than zero. */
  isPositive(): boolean {
    return this.stroops > 0n;
  }

  /**
   * Canonical decimal text: plain notation, no exponent, at most seven decimal
   * places with trailing zeros trimmed. `5` stays `"5"`, not `"5.0000000"` —
   * the value round-trips through from() either way, and the trimmed form is
   * what a client comparing against Horizon's own strings expects.
   */
  toFixed(): string {
    const negative = this.stroops < 0n;
    const magnitude = negative ? -this.stroops : this.stroops;
    const whole = magnitude / SCALE_FACTOR;
    const fraction = (magnitude % SCALE_FACTOR).toString().padStart(SCALE, '0').replace(/0+$/, '');
    const sign = negative ? '-' : '';
    return fraction ? `${sign}${whole}.${fraction}` : `${sign}${whole}`;
  }

  /** Alias for {@link toFixed} so string coercion yields canonical decimal text. */
  toString(): string {
    return this.toFixed();
  }
}

/** Exported so a test can state an expectation in stroops rather than guessing at the scale. */
export const STROOPS_PER_UNIT = SCALE_FACTOR;
/** Number of fractional decimal places on every Stellar ledger amount (7). */
export const AMOUNT_DECIMALS = SCALE;
