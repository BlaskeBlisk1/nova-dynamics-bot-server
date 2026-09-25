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
