-- Explicit migration after capture + booking. No startup DDL or activation.
CREATE TABLE IF NOT EXISTS jemlio_calendar_jobs (
  request_id uuid PRIMARY KEY REFERENCES nova_capture_requests(id) ON DELETE CASCADE,
  provider_hint text NOT NULL,
  generation bigint NOT NULL DEFAULT 1,
  available_at timestamptz,
  lease_id uuid,
  lease_until timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  updated_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS jemlio_calendar_jobs_due ON jemlio_calendar_jobs(available_at);
CREATE TABLE IF NOT EXISTS jemlio_calendar_receipts (
  digest text PRIMARY KEY,
  request_id uuid NOT NULL REFERENCES nova_capture_requests(id) ON DELETE CASCADE,
  recorded_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS jemlio_calendar_aliases (
  provider_id text PRIMARY KEY,
  request_id uuid NOT NULL REFERENCES nova_capture_requests(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS jemlio_calendar_aliases_request ON jemlio_calendar_aliases(request_id);
