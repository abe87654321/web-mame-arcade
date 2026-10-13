-- One verified score per (match, user). The verifier's score insert
-- (`ON CONFLICT DO NOTHING`) relies on this constraint so an at-least-once job
-- redelivery cannot double-count a score (T34).
ALTER TABLE scores ADD CONSTRAINT scores_match_user_key UNIQUE (match_id, user_id);
