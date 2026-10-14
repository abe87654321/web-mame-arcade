-- Anti-cheat review flags (T36). Mirror of docs/contracts/db-schema.sql.
-- The verifier writes one row per finding; UNIQUE (match_id, reason, slot)
-- makes an at-least-once job redelivery idempotent. Advisory only: this does
-- not change matches.status or the verified score.
CREATE TABLE match_flags (
  id         bigserial PRIMARY KEY,
  match_id   bigint NOT NULL REFERENCES matches(id),
  reason     text NOT NULL,
  slot       smallint NOT NULL,
  detail     jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (match_id, reason, slot)
);
