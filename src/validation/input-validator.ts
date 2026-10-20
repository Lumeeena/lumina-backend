/**
 * Centralized input validation for GraphQL resolvers
 * Addresses Issue #286: Validate query arguments consistently
 */

export class ValidationError extends Error {
  constructor(public field: string, public reason: string) {
    super(`Invalid ${field}: ${reason}`);
    this.name = 'ValidationError';
  }
}

export class InputValidator {
  /**
   * Validate Stellar address (G... format, 56 characters)
   */
  static validateAddress(addr: string, fieldName: string = 'address'): void {
    if (!addr || typeof addr !== 'string') {
      throw new ValidationError(fieldName, 'must be a non-empty string');
    }
    
    if (addr.length !== 56) {
      throw new ValidationError(fieldName, 'must be 56 characters');
    }
    
    if (!addr.startsWith('G')) {
      throw new ValidationError(fieldName, 'must start with G');
    }
    
    // Basic checksum validation (full stellar-sdk validation recommended in production)
    if (!/^G[A-Z2-7]{55}$/.test(addr)) {
      throw new ValidationError(fieldName, 'invalid Stellar address format');
    }
  }
  
  /**
   * Validate transaction/operation hash (64 hex characters)
   */
  static validateHash(hash: string, fieldName: string = 'hash'): void {
    if (!hash || typeof hash !== 'string') {
      throw new ValidationError(fieldName, 'must be a non-empty string');
    }
    
    if (!/^[0-9a-fA-F]{64}$/.test(hash)) {
      throw new ValidationError(fieldName, 'must be 64 hexadecimal characters');
    }
  }
  
  /**
   * Validate ledger sequence number
   */
  static validateLedgerSequence(seq: number, fieldName: string = 'ledger'): void {
    if (!Number.isInteger(seq) || seq < 1) {
      throw new ValidationError(fieldName, 'must be a positive integer');
    }
    
    if (seq > 2147483647) {
      throw new ValidationError(fieldName, 'exceeds maximum ledger sequence');
    }
  }
  
  /**
   * Validate asset code (1-12 alphanumeric characters)
   */
  static validateAssetCode(code: string, fieldName: string = 'assetCode'): void {
    if (!code || typeof code !== 'string') {
      throw new ValidationError(fieldName, 'must be a non-empty string');
    }
    
    if (code.length > 12) {
      throw new ValidationError(fieldName, 'must be 12 characters or less');
    }
    
    if (!/^[a-zA-Z0-9]+$/.test(code)) {
      throw new ValidationError(fieldName, 'must be alphanumeric');
    }
  }
  
  /**
   * Validate pagination limit
   */
  static validateLimit(limit: number, max: number = 200, fieldName: string = 'limit'): void {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new ValidationError(fieldName, 'must be a positive integer');
    }
    
    if (limit > max) {
      throw new ValidationError(fieldName, `must not exceed ${max}`);
    }
  }
  
  /**
   * Validate cursor string (pagination)
   */
  static validateCursor(cursor: string, fieldName: string = 'cursor'): void {
    if (!cursor || typeof cursor !== 'string') {
      throw new ValidationError(fieldName, 'must be a non-empty string');
    }
    
    // Cursors are typically base64 encoded
    if (!/^[A-Za-z0-9+/=]+$/.test(cursor)) {
      throw new ValidationError(fieldName, 'invalid cursor format');
    }
  }
  
  /**
   * Validate timestamp (Unix epoch or ISO 8601)
   */
  static validateTimestamp(ts: number | string, fieldName: string = 'timestamp'): void {
    if (typeof ts === 'number') {
      if (!Number.isInteger(ts) || ts < 0) {
        throw new ValidationError(fieldName, 'must be a non-negative integer');
      }
    } else if (typeof ts === 'string') {
      const date = new Date(ts);
      if (isNaN(date.getTime())) {
        throw new ValidationError(fieldName, 'invalid ISO 8601 timestamp');
      }
    } else {
      throw new ValidationError(fieldName, 'must be a number or string');
    }
  }
}

/**
 * Usage example:
 * 
 * import { InputValidator } from './validation/input-validator';
 * 
 * export class LedgerResolver {
 *   async getLedger(sequence: number): Promise<Ledger> {
 *     InputValidator.validateLedgerSequence(sequence, 'sequence');
 *     return this.db.getLedger(sequence);
 *   }
 * 
 *   async getAccount(address: string): Promise<Account> {
 *     InputValidator.validateAddress(address, 'address');
 *     return this.db.getAccount(address);
 *   }
 * }
 */
