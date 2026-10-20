-- Migration 015: Asset issuer metadata
--
-- Add columns to track issuer home domain and self-declared asset metadata.
-- This enables distinguishing real assets from impostors by their issuer domain.
-- Issue #257.

ALTER TABLE assets
  ADD COLUMN IF NOT EXISTS issuer_home_domain TEXT,
  ADD COLUMN IF NOT EXISTS issuer_metadata JSONB,
  ADD COLUMN IF NOT EXISTS is_lookalike BOOLEAN DEFAULT FALSE;

-- Index for issuer home domain lookups
CREATE INDEX IF NOT EXISTS idx_assets_issuer_home_domain
  ON assets (issuer_home_domain, network);

-- Index for lookalike flag
CREATE INDEX IF NOT EXISTS idx_assets_lookalike
  ON assets (is_lookalike, network) WHERE is_lookalike = TRUE;
