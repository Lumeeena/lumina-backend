# API Key Management CLI

This CLI enables operators to manage API keys for the Lumina GraphQL server without writing raw SQL.

## Security Model

- **No Plaintext Storage**: Plaintext keys are generated with 256 bits of cryptographically secure entropy (`crypto.randomBytes(32)`), formatted with a `lum_` prefix. Only their SHA-256 hash is written to the `api_keys` table.
- **Printed Once**: A newly created key is displayed exactly once in terminal output upon creation.
- **Irrecoverable**: When an operator queries an existing key (via `list` or `show`), the CLI will refuse to show the plaintext key because only the hash is retained in the database.

## Database Migration

Ensure migration `005_api_keys.sql` has been run:

```bash
psql $DATABASE_URL -f db/migrations/005_api_keys.sql
```

## CLI Usage

You can invoke the CLI from the repo root or from `graphql-server`:

```bash
# From root
npm run manage-keys -- <command> [arguments...]

# Or directly in graphql-server
cd graphql-server
npm run manage-keys -- <command> [arguments...]
```

### Commands

#### 1. Create a key
Generates a new key, saves its hash, and outputs the plaintext key once.

```bash
npm run manage-keys -- create <label> [rate_limit_req_per_min]
```
Example:
```bash
npm run manage-keys -- create mobile-app 120
```

#### 2. List all keys
Lists all keys with their metadata, ID, prefix, label, rate limit, and status (ACTIVE / REVOKED).

```bash
npm run manage-keys -- list
```

#### 3. Show key metadata
Shows full details of a key. Note that plaintext keys cannot and will not be displayed.

```bash
npm run manage-keys -- show <id|key_hash>
```

#### 4. Revoke a key
Revokes a key immediately by setting `revoked_at`.

```bash
npm run manage-keys -- revoke <id|key_hash>
```

#### 5. Update rate limit
Updates the requests-per-minute limit for an existing key.

```bash
npm run manage-keys -- set-limit <id|key_hash> <new_limit>
```
