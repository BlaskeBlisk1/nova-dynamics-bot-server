-- Apply explicitly during capture setup, never on ordinary application startup.
CREATE TABLE IF NOT EXISTS nova_capture_requests (
  id uuid PRIMARY KEY,
  client text NOT NULL,
  submission_id uuid NOT NULL,
  payload_hash text NOT NULL,
  data jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (client, submission_id)
);

CREATE TABLE IF NOT EXISTS nova_capture_outbox (
  request_id uuid PRIMARY KEY REFERENCES nova_capture_requests(id) ON DELETE CASCADE,
  notification jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','accepted','needs_review','failed')),
  attempts integer NOT NULL DEFAULT 0,
  first_attempt_at timestamptz,
  next_attempt_at timestamptz NOT NULL,
  locked_until timestamptz,
  lock_token uuid,
  provider_id text,
  error_code text,
  updated_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS nova_capture_outbox_pending ON nova_capture_outbox (next_attempt_at)
  WHERE status IN ('pending','sending');

CREATE TABLE IF NOT EXISTS nova_capture_rate_limits (
  key text PRIMARY KEY,
  bucket bigint NOT NULL,
  count integer NOT NULL
);
