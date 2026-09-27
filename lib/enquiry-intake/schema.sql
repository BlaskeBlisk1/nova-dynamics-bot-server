-- Explicit migration after capture, booking and workspace. No startup DDL.
-- These non-personal bindings prevent a later configuration mistake from moving
-- the same signed provider form (and its replayed submissions) to another tenant.
CREATE TABLE IF NOT EXISTS jemlio_enquiry_intake_sources (
  source_hash text PRIMARY KEY CHECK (source_hash ~ '^[a-f0-9]{64}$'),
  provider_hash text NOT NULL UNIQUE CHECK (provider_hash ~ '^[a-f0-9]{64}$'),
  client text NOT NULL CHECK (client ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  bound_at timestamptz NOT NULL
);
