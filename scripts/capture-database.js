"use strict";

// Operator-only commands. No public database endpoint, contact details or
// credentials are printed, and these commands never dispatch notifications.
const fs = require("node:fs");
const path = require("node:path");
const { Pool } = require("pg");

async function main() {
  const [command, ...flags] = process.argv.slice(2);
  if (!["migrate", "status"].includes(command) || flags.some(flag => flag !== "--apply")) {
    console.error("Usage: capture-database.js status | migrate --apply");
    process.exitCode = 1;
    return;
  }
  if (command === "migrate" && !flags.includes("--apply")) {
    console.error("Migration not applied. Use capture:migrate -- --apply with the intended database environment.");
    process.exitCode = 1;
    return;
  }
  if (!process.env.NOVA_DATABASE_URL) {
    console.error("Capture database is not configured: NOVA_DATABASE_URL is missing.");
    process.exitCode = 1;
    return;
  }
  const pool = new Pool({ connectionString: process.env.NOVA_DATABASE_URL,
    max: 1, connectionTimeoutMillis: 5000, query_timeout: 20_000, statement_timeout: 15_000 });
  pool.on("error", () => console.error("Capture database connection unavailable."));
  try {
    if (command === "migrate") {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(fs.readFileSync(path.join(__dirname, "../lib/capture/schema.sql"), "utf8"));
        await client.query("COMMIT");
        console.log("Capture schema applied. Feature activation and notification dispatch remain separate.");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally { client.release(); }
      return;
    }
    const schema = await pool.query(`SELECT
      to_regclass('public.nova_capture_requests') IS NOT NULL AND
      to_regclass('public.nova_capture_outbox') IS NOT NULL AND
      to_regclass('public.nova_capture_crm_outbox') IS NOT NULL AND
      to_regclass('public.nova_capture_outcomes') IS NOT NULL AND
      to_regclass('public.nova_capture_outcome_events') IS NOT NULL AND
      to_regclass('public.nova_capture_submission_tombstones') IS NOT NULL AND
      to_regclass('public.nova_capture_rate_limits') IS NOT NULL AS ready`);
    if (!schema.rows[0]?.ready) {
      console.error("Capture schema is incomplete. No changes were made.");
      process.exitCode = 1;
      return;
    }
    const queue = await pool.query(`SELECT r.client, o.status, count(*)::integer AS count,
      floor(extract(epoch from (now()-min(r.created_at)))/60)::integer AS oldest_minutes
      FROM nova_capture_outbox o JOIN nova_capture_requests r ON r.id=o.request_id
      GROUP BY r.client,o.status ORDER BY r.client,o.status`);
    const crmQueue = await pool.query(`SELECT r.client, o.status, count(*)::integer AS count,
      floor(extract(epoch from (now()-min(r.created_at)))/60)::integer AS oldest_minutes
      FROM nova_capture_crm_outbox o JOIN nova_capture_requests r ON r.id=o.request_id
      GROUP BY r.client,o.status ORDER BY r.client,o.status`);
    console.log(JSON.stringify({ schemaReady: true, queue: queue.rows, crmQueue: crmQueue.rows,
      note: "accepted means email-provider acceptance, not delivery. synced means Airtable returned the saved receipt and fields. Reconcile needs_review before retrying." }, null, 2));
  } catch {
    console.error("Capture database operation failed. Inspect connection permissions or schema using restricted operator access.");
    process.exitCode = 1;
  } finally { await pool.end(); }
}

void main();
