'use strict';
// Restricted operator commands. No sending capability and no contact/secret output.
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { Pool } = require('pg');
const { BookingStore } = require('../lib/booking/store');
const { createCalendly } = require('../lib/booking/calendly');
const HELP = `Usage: booking-operations.js COMMAND [options]
  migrate --apply
  due --client SLUG [--hours 24] [--limit 100]
  report --client SLUG [--since UTC_ISO] [--before UTC_ISO]
  schedule --client SLUG --receipt UUID --action callback|review|reconcile|done [--due UTC_ISO] [--apply]
  result --client SLUG --receipt UUID --status completed|cancelled|no_show|sale [--amount-ore INTEGER] [--apply]
  reconcile --client SLUG --receipt UUID [--provider-id CALENDLY_INVITEE_URI] [--apply]
Mutations preview unless --apply. Sale requires an independently recorded won outcome.
Result records observed facts only. Reconcile reads Calendly; no command books, charges or sends.`;
function parse(argv) {
  const [command, ...rest] = argv;
  const allowed = { migrate: ['apply'], due: ['client', 'hours', 'limit'], report: ['client', 'since', 'before'],
    schedule: ['client', 'receipt', 'action', 'due', 'apply'], result: ['client', 'receipt', 'status', 'amount-ore', 'apply'],
    reconcile: ['client', 'receipt', 'provider-id', 'apply'] }[command];
  if (!allowed) throw new Error('invalid_command');
  const args = {};
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i].slice(2);
    if (!rest[i].startsWith('--') || !allowed.includes(key) || Object.hasOwn(args, key)) throw new Error('invalid_arguments');
    if (key === 'apply') args[key] = true;
    else { const value = rest[++i]; if (!value || value.startsWith('--')) throw new Error('missing_argument'); args[key] = value; }
  }
  if (command !== 'migrate' && !args.client || ['schedule', 'result', 'reconcile'].includes(command) && !args.receipt) throw new Error('missing_argument');
  for (const key of ['hours', 'limit', 'amount-ore']) if (args[key] !== undefined) {
    if (!/^\d+$/.test(args[key]) || !Number.isSafeInteger(Number(args[key]))) throw new Error('invalid_number');
    args[key] = Number(args[key]);
  }
  if (args['amount-ore'] !== undefined) { args.amountOre = args['amount-ore']; delete args['amount-ore']; }
  if (args['provider-id']) { args.providerId = args['provider-id']; delete args['provider-id']; }
  return { command, args };
}
async function main() {
  let parsed;
  try { parsed = parse(process.argv.slice(2)); } catch { console.error(HELP); process.exitCode = 1; return; }
  if (!process.env.NOVA_DATABASE_URL) { console.error('Booking database is not configured.'); process.exitCode = 1; return; }
  const pool = new Pool({ connectionString: process.env.NOVA_DATABASE_URL, max: 1,
    connectionTimeoutMillis: 5000, query_timeout: 15000, statement_timeout: 15000 });
  pool.on('error', () => console.error('Booking database unavailable.'));
  try {
    const { command, args } = parsed;
    const store = new BookingStore({ pool });
    if (command === 'migrate') {
      if (!args.apply) { console.log('Migration not applied. Re-run with --apply in the intended database.'); return; }
      await store.transaction(db => db.query(readFileSync(join(__dirname, '../lib/booking/schema.sql'), 'utf8')));
      console.log('Booking schema applied. No feature enabled and no messages sent.'); return;
    }
    if (command === 'reconcile') {
      const cfg = JSON.parse(process.env.JEMLIO_BOOKING_CONFIG || '{}')[args.client];
      if (!/^JEMLIO_CALENDLY_[A-Z0-9_]+$/.test(cfg?.credentialEnv || '')) throw new Error('missing_provider');
      args.provider = createCalendly({ token: process.env[cfg.credentialEnv] });
    }
    console.log(JSON.stringify(await store[{ result: 'record' }[command] || command](args), null, 2));
  } catch (error) {
    const codes = ['invalid_scope','invalid_date','invalid_date_range','invalid_action','invalid_queue_scope','invalid_result',
      'invalid_amount','verified_win_required','confirmed_booking_required','appointment_not_started','request_closed',
      'request_not_found','provider_record_mismatch','reconciliation_not_allowed','booking_state_changed'];
    console.error(codes.includes(error.code) ? `Operation rejected: ${error.code}.` : 'Operation unavailable. Check schema and approved configuration. No message sent.');
    process.exitCode = 1;
  } finally { await pool.end(); }
}
if (require.main === module) void main();
module.exports = { parse };
