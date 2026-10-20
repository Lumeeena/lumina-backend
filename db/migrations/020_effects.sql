-- Migration 020: Horizon effects, read by the `effects` GraphQL query
-- Run with: psql $DATABASE_URL -f db/migrations/020_effects.sql
--
-- An effect is the normalised record of what an operation did to one account:
-- one payment produces an `account_debited` on the sender and an
-- `account_credited` on the recipient, and a path payment adds a `trade` per
-- offer it crossed. That makes effects the natural basis for an account
-- activity feed (issue #225), instead of reconstructing one from raw
-- operation payloads.
--
-- The table mirrors Horizon's /effects record. Populating it per ledger,
-- alongside operations, is the indexer's job (issue #203); this migration only
-- defines the shape the API reads.
--
--   id            Horizon's effect id, "<operation id>-<order>", both halves
--                 zero-padded, so it sorts in chain order within a ledger.
--   operation_id  The operation that produced the effect (the id's first half).
--   ledger        Ledger the operation closed in. Stored rather than derived
--                 from the operation id so the keyset (ledger, id) is indexable.
--   details       Horizon's type-specific fields, verbatim. The API maps them
--                 to a typed GraphQL shape per effect type.

CREATE TABLE IF NOT EXISTS effects (
    id            TEXT NOT NULL,
    paging_token  TEXT NOT NULL,
    operation_id  TEXT NOT NULL,
    ledger        BIGINT NOT NULL,
    account       TEXT NOT NULL,
    type          TEXT NOT NULL,
    type_i        INTEGER NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL,
    details       JSONB NOT NULL DEFAULT '{}'::jsonb,
    network       TEXT NOT NULL DEFAULT 'mainnet',
    indexed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (id, network),
    CONSTRAINT effects_id_check   CHECK (id <> ''),
    CONSTRAINT effects_type_check CHECK (type <> '')
);

-- effects(account): one account's feed, newest first, resumed by (ledger, id).
CREATE INDEX IF NOT EXISTS idx_effects_account
    ON effects (account, network, ledger DESC, id DESC);

-- effects(account, type): the same feed narrowed to one effect type.
CREATE INDEX IF NOT EXISTS idx_effects_account_type
    ON effects (account, type, network, ledger DESC, id DESC);
