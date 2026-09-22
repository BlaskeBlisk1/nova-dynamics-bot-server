'use strict';

// Generates a synthetic local preview only. No database or email provider is used.
const fs = require('node:fs');
const { buildWebsiteNotification, OWNER_WORKSPACE } = require('../lib/website-enquiry-notification');

const output = process.argv[2];
if (!output) { console.error('Usage: node scripts/preview-website-alert.js /absolute/path/preview.html'); process.exit(1); }
const notification = buildWebsiteNotification({
  name: 'Eksempelperson', email: 'demo@example.invalid', business: 'Eksempelbedrift AS',
  website: 'https://example.invalid', industry: 'Trafikkskole', sourceCreatedAt: '2026-09-22T14:30:00Z',
  message: 'Dette er en oppdiktet forhåndsvisning. Vi vil gjerne se hvordan chatboten kan hjelpe oss med vanlige spørsmål og kontaktforespørsler.'
}, '00000000-0000-4000-8000-000000000001', {
  from: 'sender@example.invalid', recipient: 'owner@example.invalid',
  destination: { baseId: OWNER_WORKSPACE.baseId, tableId: OWNER_WORKSPACE.tableId }
});
fs.writeFileSync(output, notification.html, { mode: 0o600 });
console.log('Synthetic preview written. No email sent.');
