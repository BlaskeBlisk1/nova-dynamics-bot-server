-- Explicit additive migration after capture, booking and workspace. No startup DDL.
CREATE TABLE IF NOT EXISTS jemlio_conversation_threads (
  request_id uuid PRIMARY KEY REFERENCES nova_capture_requests(id) ON DELETE CASCADE,
  client text NOT NULL,
  version bigint NOT NULL DEFAULT 1,
  context_version bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS jemlio_conversation_messages (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL REFERENCES nova_capture_requests(id) ON DELETE CASCADE,
  client text NOT NULL,
  direction text NOT NULL CHECK(direction IN ('inbound','outbound')),
  state text NOT NULL CHECK(state IN ('received','draft','superseded','queued','sending','accepted','delivered','bounced','complained','failed','needs_review','cancelled','stale')),
  template text,
  subject text NOT NULL CHECK(length(subject)<=200),
  body text NOT NULL CHECK(length(body)<=2000),
  recipient text,
  context_version bigint NOT NULL,
  submission_id uuid,
  payload_hash text,
  approved_at timestamptz,
  approved_by text,
  encrypted_payload text,
  sender_hash text,
  attempts integer NOT NULL DEFAULT 0,
  first_attempt_at timestamptz,
  next_attempt_at timestamptz,
  locked_until timestamptz,
  lock_token uuid,
  provider_id text UNIQUE,
  error_code text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE(request_id,submission_id)
);
CREATE INDEX IF NOT EXISTS jemlio_conversation_history ON jemlio_conversation_messages(request_id,created_at,id);
CREATE INDEX IF NOT EXISTS jemlio_conversation_dispatch ON jemlio_conversation_messages(next_attempt_at)
  WHERE state IN ('queued','sending');
CREATE TABLE IF NOT EXISTS jemlio_conversation_tokens (
  token_hash text PRIMARY KEY,
  request_id uuid NOT NULL REFERENCES nova_capture_requests(id) ON DELETE CASCADE,
  message_id uuid NOT NULL UNIQUE REFERENCES jemlio_conversation_messages(id) ON DELETE CASCADE,
  client text NOT NULL,
  recipient text NOT NULL,
  expires_at timestamptz NOT NULL
);
-- Callback ledger deliberately contains no raw webhook, message text or address.
CREATE TABLE IF NOT EXISTS jemlio_conversation_delivery_events (
  event_id text PRIMARY KEY,
  provider_id text NOT NULL,
  kind text NOT NULL CHECK(kind IN ('delivered','bounced','complained')),
  received_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS jemlio_conversation_delivery_provider ON jemlio_conversation_delivery_events(provider_id);
-- Suppression survives enquiry deletion; hash only, scoped to a business.
CREATE TABLE IF NOT EXISTS jemlio_conversation_suppressions (
  client text NOT NULL,
  recipient_hash text NOT NULL,
  reason text NOT NULL CHECK(reason IN ('bounced','complained')),
  created_at timestamptz NOT NULL,
  PRIMARY KEY(client,recipient_hash)
);
