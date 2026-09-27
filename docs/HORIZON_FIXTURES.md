# Testing the Horizon Client with Recorded Responses

Parsing tests for the Horizon client use fixtures recorded from real Horizon API responses. This ensures tests verify against actual response shapes, not hand-written approximations that can diverge.

## Why Real Fixtures Matter

Hand-written fixtures encode what someone believed Horizon returns. Field-name mistakes of exactly this kind have caused crashes in the past (e.g., the frontend's ledger fields were incorrect), and a hand-written fixture would have silently agreed with the bug.

Recording real responses protects against:
- Typos in field names (`closed_at` vs `closedAt`)
- Missing optional fields that should be handled
- Changes to Horizon's API over time

## Recording New Fixtures

When Horizon's response shape changes or you need to add new test cases:

1. **Fetch a real response from Horizon:**

```bash
# Get a ledger
curl https://horizon.stellar.org/ledgers/100000 | jq .

# Get transactions for a ledger
curl "https://horizon.stellar.org/ledgers/100000/transactions?order=asc&limit=200" | jq .

# Get an account
curl "https://horizon.stellar.org/accounts/GBRPYHIL2CI537KXVHBV4Z6G7MXNGSQXN4F2XGJFFHJ3KJV3J4WKZQLQ" | jq .
```

2. **Update the fixture file:**

The fixtures are stored in `indexer/src/__fixtures__/horizon.json`. Each fixture should include:
- The full response object (exactly as Horizon returns it)
- Realistic data (real-looking addresses, amounts, timestamps)
- Minimal required fields for the use case

3. **Update the test:**

Replace test assertions to verify the actual fields parsed from the real response. For example:

```typescript
test('getLedger parses all fields from recorded response', async () => {
  mockFetchSequence([{ ok: true, body: fixtures.ledger }]);
  const ledger = await getLedger('https://horizon.example.com', 52481234);
  
  // Verify all fields are parsed correctly
  assert.equal(ledger.sequence, fixtures.ledger.sequence);
  assert.equal(ledger.closed_at, fixtures.ledger.closed_at);
  assert.equal(ledger.base_fee_in_stroops, fixtures.ledger.base_fee_in_stroops);
});
```

## Structure

The fixture file is organized by response type:

```json
{
  "ledger": { /* single ledger response */ },
  "ledgerPage": { /* paginated ledger response */ },
  "transaction": { /* single transaction response */ },
  "transactionPage": { /* paginated transaction response */ },
  "operation": { /* single operation response */ },
  "operationPage": { /* paginated operation response */ },
  "account": { /* account response */ }
}
```

## Maintenance

Fixtures should be reviewed and refreshed:
- When Horizon announces API changes
- When adding support for new fields
- If a real-world request reveals a field the tests don't cover

The goal is to catch shape mismatches at test time, not in production.
