'use strict';

// Never fall back to application credentials or connect to a production database.
async function main() {
  const raw = process.env.JEMLIO_TEST_DATABASE_URL;
  if (!raw) {
    console.log('Skipped real PostgreSQL enquiry-conversation checks: JEMLIO_TEST_DATABASE_URL is not configured.');
    return;
  }
  if (process.env.JEMLIO_THROWAWAY_DATABASE !== 'true') {
    throw new Error('Explicit disposable database configuration required');
  }
  let url;
  try { url = new URL(raw); } catch { throw new Error('Invalid disposable database configuration'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) ||
      !['127.0.0.1', 'localhost'].includes(url.hostname) ||
      url.pathname !== '/jemlio_capture_ci' || url.search || url.hash) {
    throw new Error('Only the named localhost CI database is permitted');
  }

  // Shared router checks use an ephemeral loopback HTTP server. Block provider
  // traffic before loading the suite, including redirects away from that server.
  const localFetch = global.fetch;
  global.fetch = async (input, options) => {
    let target;
    try { target = new URL(typeof input === 'string' || input instanceof URL ? input : input.url); }
    catch { throw new Error('Only local HTTP test servers are permitted'); }
    if (target.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(target.hostname) ||
        !target.port || Number(target.port) < 1024 || target.username || target.password) {
      throw new Error('Only local HTTP test servers are permitted');
    }
    return localFetch(input, { ...options, redirect: 'error' });
  };
  const { Pool } = require('pg');
  const { runTests } = require('./test-enquiry-conversations');
  if (typeof runTests !== 'function') throw new Error('Shared enquiry-conversation test runner is unavailable');
  const pool = new Pool({
    connectionString: raw,
    max: 12,
    connectionTimeoutMillis: 5000,
    statement_timeout: 15000
  });
  try {
    await runTests({ pool, realPostgres: true });
    console.log('Real PostgreSQL enquiry-conversation checks passed. No provider calls or production database access.');
  } finally {
    await pool.end();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
