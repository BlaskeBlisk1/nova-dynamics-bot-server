-- Operator-only additive migration. No DDL executes during application startup.
CREATE TABLE IF NOT EXISTS jemlio_missed_calls (
 id uuid PRIMARY KEY,
 client text NOT NULL,
 account_sid text NOT NULL,
 parent_sid text NOT NULL,
 child_sid text NOT NULL,
 event_hash text NOT NULL,
 phone_key text NOT NULL,
 config_hash text NOT NULL,
 encrypted_payload text,
 token_hash text UNIQUE,
 state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','verifying','sending','accepted','sent','delivered','failed','uncertain','blocked')),
 reason text,
 provider_sid text,
 delivery_rank integer NOT NULL DEFAULT 0,
 attempts integer NOT NULL DEFAULT 0,
 claim uuid,
 lease_until timestamptz,
 available_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL,
 expires_at timestamptz NOT NULL,
 attempted_at timestamptz,
 revoked boolean NOT NULL DEFAULT false,
 receipt uuid NOT NULL,
 request_id uuid REFERENCES nova_capture_requests(id) ON DELETE SET NULL,
 submitted_hash text,
 UNIQUE(account_sid,parent_sid)
);
CREATE INDEX IF NOT EXISTS jemlio_missed_call_pending ON jemlio_missed_calls(state,available_at);
CREATE INDEX IF NOT EXISTS jemlio_missed_call_client ON jemlio_missed_calls(client,created_at DESC);
CREATE TABLE IF NOT EXISTS jemlio_missed_call_guards (client text PRIMARY KEY);
CREATE TABLE IF NOT EXISTS jemlio_sms_suppressions (
 client text NOT NULL,
 phone_key text NOT NULL,
 created_at timestamptz NOT NULL,
 PRIMARY KEY(client,phone_key)
);
-- Pin the encryption/HMAC key fingerprint: rotation must not silently erase opt-outs.
CREATE TABLE IF NOT EXISTS jemlio_missed_call_keyring (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), fingerprint text NOT NULL
);
