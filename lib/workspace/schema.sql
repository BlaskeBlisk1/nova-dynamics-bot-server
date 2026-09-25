-- Apply explicitly after capture and booking migrations. No startup DDL.
CREATE TABLE IF NOT EXISTS jemlio_workspace_sessions (
  token_hash text PRIMARY KEY,
  client text NOT NULL,
  credential_hash text NOT NULL,
  csrf text NOT NULL,
  expires_at timestamptz NOT NULL,
  last_seen timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS jemlio_workspace_sessions_expiry ON jemlio_workspace_sessions(expires_at);
CREATE TABLE IF NOT EXISTS jemlio_workspace_notes (
  request_id uuid PRIMARY KEY REFERENCES nova_capture_requests(id) ON DELETE CASCADE,
  note text NOT NULL CHECK (length(note) <= 2000),
  updated_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS jemlio_workspace_audit (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL REFERENCES nova_capture_requests(id) ON DELETE CASCADE,
  actor text NOT NULL,
  fields text[] NOT NULL,
  recorded_at timestamptz NOT NULL
);

-- Price proposals collect a request for personal follow-up, not payment or a signed contract.
CREATE TABLE IF NOT EXISTS jemlio_offers (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL REFERENCES nova_capture_requests(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK(version>0),
  token_hash text NOT NULL UNIQUE,
  data jsonb NOT NULL,
  state text NOT NULL CHECK(state IN ('open','responded','withdrawn','superseded')),
  response text CHECK(response IN ('interested','changes','declined')),
  response_note text CHECK(length(response_note)<=800),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  responded_at timestamptz,
  UNIQUE(request_id,version)
);
CREATE UNIQUE INDEX IF NOT EXISTS jemlio_offers_one_open ON jemlio_offers(request_id) WHERE state='open';
CREATE INDEX IF NOT EXISTS jemlio_offers_request_version ON jemlio_offers(request_id,version DESC);
CREATE TABLE IF NOT EXISTS jemlio_offer_events (
  id uuid PRIMARY KEY,
  offer_id uuid NOT NULL REFERENCES jemlio_offers(id) ON DELETE CASCADE,
  request_id uuid NOT NULL REFERENCES nova_capture_requests(id) ON DELETE CASCADE,
  action text NOT NULL,
  recorded_at timestamptz NOT NULL
);
