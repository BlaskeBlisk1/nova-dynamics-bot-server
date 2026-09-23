-- Explicit additive migration, after the capture schema. No automatic startup DDL.
CREATE TABLE IF NOT EXISTS jemlio_bookings (
  request_id uuid PRIMARY KEY REFERENCES nova_capture_requests(id) ON DELETE CASCADE,
  attempt_id uuid NOT NULL UNIQUE,
  payload_hash text NOT NULL,
  event_type text NOT NULL,
  slot timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('attempting','confirmed','needs_review','rejected','cancelled','completed','no_show')),
  provider_id text UNIQUE,
  cancel_url text,
  reschedule_url text,
  error_code text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS jemlio_followups (
  request_id uuid PRIMARY KEY REFERENCES nova_capture_requests(id) ON DELETE CASCADE,
  due_at timestamptz,
  action text NOT NULL CHECK (action IN ('callback','review','reconcile','done')),
  updated_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS jemlio_recorded_sales (
  request_id uuid PRIMARY KEY REFERENCES nova_capture_requests(id) ON DELETE CASCADE,
  amount_ore bigint NOT NULL CHECK (amount_ore >= 0 AND amount_ore <= 10000000000),
  recorded_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS jemlio_workflow_events (
  id uuid PRIMARY KEY,
  request_id uuid NOT NULL REFERENCES nova_capture_requests(id) ON DELETE CASCADE,
  action text NOT NULL,
  recorded_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS jemlio_followups_due ON jemlio_followups(due_at);
