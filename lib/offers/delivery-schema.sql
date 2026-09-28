-- Additive migration after workspace and enquiry-conversations. Never runs on startup.
CREATE TABLE IF NOT EXISTS jemlio_offer_deliveries (
  operation_id uuid PRIMARY KEY,
  client text NOT NULL,
  request_id uuid NOT NULL REFERENCES nova_capture_requests(id) ON DELETE CASCADE,
  offer_id uuid NOT NULL UNIQUE REFERENCES jemlio_offers(id) ON DELETE CASCADE,
  message_id uuid NOT NULL UNIQUE REFERENCES jemlio_conversation_messages(id) ON DELETE CASCADE,
  payload_hash text NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS jemlio_offer_delivery_request ON jemlio_offer_deliveries(request_id);
