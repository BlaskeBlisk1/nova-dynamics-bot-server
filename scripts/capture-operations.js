'use strict';

// Restricted operator CLI only. No public API, provider request, PII or secret
// output. Mutations preview by default and require an explicit --apply.
const { Pool } = require('pg');
const { CaptureOperations } = require('../lib/capture/operations');

const USAGE = `Usage:
  node scripts/capture-operations.js report --client SLUG [--since ISO_DATE] [--before ISO_DATE]
  node scripts/capture-operations.js outcome --client SLUG --receipt UUID --status new|contacted|qualified|won|lost [--apply]
  node scripts/capture-operations.js delete --client SLUG [--receipt UUID] [--before ISO_DATE] [--limit 100] [--apply]
Deletion requires a receipt or cutoff. No default retention period is assumed.`;

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const allowed = { report: ['client', 'since', 'before'], outcome: ['client', 'receipt', 'status', 'apply'], delete: ['client', 'receipt', 'before', 'limit', 'apply'] }[command];
  if (!allowed) throw new Error('invalid_command');
  const options = {};
  for (let i = 0; i < rest.length; i++) {
    if (!rest[i].startsWith('--')) throw new Error('invalid_arguments');
    const name = rest[i].slice(2);
    if (!allowed.includes(name) || Object.hasOwn(options, name)) throw new Error('invalid_arguments');
    if (name === 'apply') options.apply = true;
    else {
      const value = rest[++i];
      if (!value || value.startsWith('--')) throw new Error('missing_argument');
      options[name] = value;
    }
  }
  if (!options.client || command === 'outcome' && (!options.receipt || !options.status)) throw new Error('missing_argument');
  if (options.limit !== undefined) {
    if (!/^\d+$/.test(options.limit)) throw new Error('invalid_limit');
    options.limit = Number(options.limit);
  }
  if (options.status !== undefined) { options.outcome = options.status; delete options.status; }
  return { command, options };
}

async function main(argv = process.argv.slice(2)) {
  let parsed;
  try { parsed = parseArgs(argv); }
  catch { console.error(USAGE); process.exitCode = 1; return; }
  if (!process.env.NOVA_DATABASE_URL) {
    console.error('Capture database is not configured: NOVA_DATABASE_URL is missing. No changes made.');
    process.exitCode = 1; return;
  }
  const pool = new Pool({ connectionString: process.env.NOVA_DATABASE_URL,
    max: 1, connectionTimeoutMillis: 5000, query_timeout: 20_000, statement_timeout: 15_000 });
  pool.on('error', () => console.error('Capture database connection unavailable.'));
  try {
    const operations = new CaptureOperations({ pool });
    const method = { report: 'report', outcome: 'setOutcome', delete: 'deleteRequests' }[parsed.command];
    console.log(JSON.stringify(await operations[method](parsed.options), null, 2));
  } catch (error) {
    const known = /^(invalid_(client|receipt|outcome|since|before|date_range|limit)|request_not_found|deletion_scope_required|future_deletion_cutoff)$/;
    console.error(known.test(error.code || '') ? `Capture operation rejected: ${error.code}.`
      : 'Capture database operation failed. Check the applied schema and restricted database access. No notification was sent.');
    process.exitCode = 1;
  } finally { await pool.end(); }
}

if (require.main === module) void main();
module.exports = { parseArgs, main };
