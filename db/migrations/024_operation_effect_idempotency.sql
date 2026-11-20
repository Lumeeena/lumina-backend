-- The indexer may replay a ledger. Record per-handler operation effects so
-- additive analytics and balances are only applied once.
CREATE TABLE IF NOT EXISTS processed_operation_handlers (
    operation_id TEXT NOT NULL,
    handler      TEXT NOT NULL CHECK (handler IN ('asset', 'liquidity_pool')),
    network      TEXT NOT NULL DEFAULT 'mainnet',
    processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (operation_id, handler, network)
);

-- Existing aggregates already include successfully processed historical
-- operations. Seed the markers so a replay after deployment cannot add them a
-- second time. Pending dead letters stay retryable.
INSERT INTO processed_operation_handlers (operation_id, handler, network)
SELECT o.id, 'asset', o.network
FROM operations o
WHERE o.type IN ('change_trust', 'payment', 'path_payment_strict_send', 'path_payment_strict_receive')
  AND NOT EXISTS (
    SELECT 1 FROM dead_letter_operations d
    WHERE d.network = o.network AND d.operation_id = o.id AND d.status = 'pending'
  )
ON CONFLICT DO NOTHING;

INSERT INTO processed_operation_handlers (operation_id, handler, network)
SELECT o.id, 'liquidity_pool', o.network
FROM operations o
WHERE o.type IN ('liquidity_pool_deposit', 'liquidity_pool_withdraw')
  AND NOT EXISTS (
    SELECT 1 FROM dead_letter_operations d
    WHERE d.network = o.network AND d.operation_id = o.id AND d.status = 'pending'
  )
ON CONFLICT DO NOTHING;

INSERT INTO schema_migrations (version)
VALUES ('024_operation_effect_idempotency')
ON CONFLICT (version) DO NOTHING;
