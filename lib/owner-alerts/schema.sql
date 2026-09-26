-- Explicit migration after capture, booking and workspace. Never run on startup.
CREATE TABLE IF NOT EXISTS jemlio_owner_alerts (
  id uuid PRIMARY KEY,
  client text NOT NULL,
  event_key text NOT NULL,
  kind text NOT NULL CHECK(kind IN ('response','digest')),
  offer_id uuid REFERENCES jemlio_offers(id) ON DELETE CASCADE,
  notification jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','accepted','failed','needs_review')),
  attempts integer NOT NULL DEFAULT 0,
  first_attempt_at timestamptz,
  next_attempt_at timestamptz NOT NULL,
  locked_until timestamptz,
  lock_token uuid,
  provider_id text,
  error_code text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE(client,event_key)
);
CREATE INDEX IF NOT EXISTS jemlio_owner_alerts_pending ON jemlio_owner_alerts(next_attempt_at) WHERE status IN ('pending','sending');
