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

-- Optional CRM replication shares the request transaction, but retries
-- independently of email. Destination and visitor fields are frozen at capture.
CREATE TABLE IF NOT EXISTS nova_capture_crm_outbox (
  request_id uuid PRIMARY KEY REFERENCES nova_capture_requests(id) ON DELETE CASCADE,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','synced','needs_review')),
  attempts integer NOT NULL DEFAULT 0,
  first_attempt_at timestamptz,
  next_attempt_at timestamptz NOT NULL,
  locked_until timestamptz,
  lock_token uuid,
  record_id text,
  error_code text,
  updated_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS nova_capture_crm_pending ON nova_capture_crm_outbox (next_attempt_at)
  WHERE status IN ('pending','sending');

CREATE TABLE IF NOT EXISTS nova_capture_rate_limits (
  key text PRIMARY KEY,
  bucket bigint NOT NULL,
  count integer NOT NULL
);

-- Business outcomes are operator-recorded facts, independent of email delivery.
-- Requests without a row are new. Explicit history preserves earlier stages
-- when an operator later marks the same enquiry won or lost.
CREATE TABLE IF NOT EXISTS nova_capture_outcomes (
  request_id uuid PRIMARY KEY REFERENCES nova_capture_requests(id) ON DELETE CASCADE,
  outcome text NOT NULL CHECK (outcome IN ('new','contacted','qualified','won','lost')),
  updated_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS nova_capture_outcome_events (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL REFERENCES nova_capture_requests(id) ON DELETE CASCADE,
  outcome text NOT NULL CHECK (outcome IN ('new','contacted','qualified','won','lost')),
  recorded_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS nova_capture_outcome_events_request ON nova_capture_outcome_events (request_id);
CREATE INDEX IF NOT EXISTS nova_capture_requests_client_created ON nova_capture_requests (client,created_at);

-- Keep an opaque submission ID guard after contact details are deleted. Without
-- it, a delayed browser retry could recreate the enquiry and dispatch email.
-- This intentionally has no request foreign key or contact/payload fields.
CREATE TABLE IF NOT EXISTS nova_capture_submission_tombstones (
  client text NOT NULL,
  submission_id uuid NOT NULL,
  deleted_at timestamptz NOT NULL,
  PRIMARY KEY (client,submission_id)
);
