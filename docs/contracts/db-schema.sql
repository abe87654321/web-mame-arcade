-- PostgreSQL 16
CREATE TABLE games (
  id            serial PRIMARY KEY,
  driver        text UNIQUE NOT NULL,      -- e.g. 'gridlee'
  title         text NOT NULL,
  core_version  text NOT NULL,             -- core_hash: sha256 of the served core (contracts/core-version.md)
  supports_save boolean NOT NULL,
  netplay_mode  text NOT NULL CHECK (netplay_mode IN ('none','lockstep','rollback')),
  max_players   smallint NOT NULL DEFAULT 2,
  rom_licensed  boolean NOT NULL DEFAULT false
);
CREATE TABLE users (
  id         bigserial PRIMARY KEY,
  name       text UNIQUE NOT NULL,
  country    char(2),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE matches (
  id           bigserial PRIMARY KEY,
  game_id      int NOT NULL REFERENCES games(id),
  mode         text NOT NULL CHECK (mode IN ('solo','coop','versus')),
  core_version text NOT NULL,              -- core_hash: sha256 of the core that played it
  mame_commit  text NOT NULL,              -- mame/ commit the core was built from (verifier rebuilds from it)
  rom_hash     text NOT NULL,
  dip_settings jsonb NOT NULL,
  started_at   timestamptz NOT NULL,
  ended_at     timestamptz,
  replay_key   text,                       -- object storage key of the input log
  status       text NOT NULL CHECK (status IN ('live','ended','verified','flagged'))
);
CREATE TABLE match_players (
  match_id bigint REFERENCES matches(id),
  user_id  bigint REFERENCES users(id),
  slot     smallint NOT NULL,
  PRIMARY KEY (match_id, slot)
);
CREATE TABLE scores (
  id          bigserial PRIMARY KEY,
  match_id    bigint NOT NULL REFERENCES matches(id),
  user_id     bigint NOT NULL REFERENCES users(id),
  game_id     int NOT NULL REFERENCES games(id),
  score       bigint NOT NULL,
  verified_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX scores_board ON scores (game_id, score DESC);
