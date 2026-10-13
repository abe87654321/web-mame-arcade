-- One replay artifact per match. The verifier upserts `matches` by
-- `replay_key` (T34), so redelivered jobs cannot create duplicate matches.
CREATE UNIQUE INDEX IF NOT EXISTS matches_replay_key_key ON matches (replay_key);
