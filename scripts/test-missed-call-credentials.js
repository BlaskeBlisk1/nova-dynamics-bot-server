'use strict';
const assert = require('node:assert/strict');
const twilio = require('twilio');
const { configuration } = require('../lib/missed-calls/config');
const { createApiClient, validate } = require('../lib/missed-calls/twilio');
const account = 'AC' + 'a'.repeat(32), other = 'AC' + 'b'.repeat(32);
const auth = 'c'.repeat(32), key = 'SK' + 'd'.repeat(32), apiSecret = 'e'.repeat(32);
const tenant = { enabled: true, routingApproved: true, smsApproved: true,
  voiceNumber: '+4722222222', forwardTo: '+4733333333', smsFrom: '+4744444444',
  activatedAt: '2026-10-01T00:00:00Z', dailyLimit: 5, smsText: 'Hei {link} STOP',
  testRecipients: ['+4799999999'], liveRecipientsApproved: false };
const base = { JEMLIO_MISSED_CALL_ORIGIN: 'https://example.invalid',
  JEMLIO_MISSED_CALL_KEY: Buffer.alloc(32, 1).toString('base64') };
const shared = { TWILIO_ACCOUNT_SID: account, TWILIO_AUTH_TOKEN: auth,
  TWILIO_API_KEY_SID: key, TWILIO_API_KEY_SECRET: apiSecret };
function config(t = tenant, env = shared) {
  return configuration({ ...base, ...env, JEMLIO_MISSED_CALL_CONFIG: JSON.stringify({ alpha: t }) });
}
const resolved = config().tenants.alpha;
assert.equal(resolved.accountSid, account);
assert.equal(resolved.authToken, auth);
assert.equal(resolved.apiKeySid, key);
assert.equal(resolved.apiKeySecret, apiSecret);
assert.equal(config({ ...tenant, accountSid: account }).tenants.alpha.apiKeySid, key);
// API credentials must not stand in for the signature-verification token.
assert.equal(config(tenant, { ...shared, TWILIO_AUTH_TOKEN: undefined }), null);
assert.equal(config(tenant, { ...shared, TWILIO_AUTH_TOKEN: '' }), null);
for (const env of [
  { ...shared, TWILIO_API_KEY_SECRET: undefined },
  { ...shared, TWILIO_API_KEY_SID: undefined },
  { ...shared, TWILIO_API_KEY_SID: account },
  { ...shared, TWILIO_API_KEY_SECRET: ' secret ' },
  { ...shared, TWILIO_ACCOUNT_SID: 'invalid' }
]) assert.equal(config(tenant, env), null);
assert.equal(config({ ...tenant, apiKeySid: key }), null);
assert.equal(config({ ...tenant, apiKeySecret: apiSecret }), null);
// Account scoping and explicit empty values fail closed.
assert.equal(config({ ...tenant, accountSid: other }), null);
assert.equal(config({ ...tenant, accountSid: '' }), null);
assert.equal(config({ ...tenant, authToken: '' }), null);
const isolated = config({ ...tenant, accountSid: other, authToken: auth }).tenants.alpha;
assert.equal(isolated.apiKeySid, undefined);
assert.equal(isolated.apiKeySecret, undefined);
const explicit = config({ ...tenant, accountSid: other, authToken: auth,
  apiKeySid: 'SK' + 'f'.repeat(32), apiKeySecret: 'tenant-secret' }).tenants.alpha;
assert.equal(explicit.apiKeySecret, 'tenant-secret');
// Existing Auth Token-only configurations remain valid.
const legacy = config({ ...tenant, accountSid: account, authToken: auth }, {}).tenants.alpha;
assert.equal(legacy.fingerprint, resolved.fingerprint);
// Credentials alone must never create a tenant or activate routing/sending.
assert.equal(configuration({ ...base, ...shared }), null);
for (const flag of ['enabled', 'routingApproved', 'smsApproved']) {
  assert.equal(config({ ...tenant, [flag]: false }), null);
}
let args;
const fakeFactory = (...values) => { args = values; return {}; };
createApiClient(resolved, fakeFactory);
assert.deepEqual(args, [key, apiSecret, { accountSid: account, autoRetry: false, timeout: 8000, maxRetries: 0 }]);
createApiClient(legacy, fakeFactory);
assert.equal(args[0], account); assert.equal(args[1], auth);
assert.throws(() => createApiClient({ ...resolved, apiKeySecret: undefined }, fakeFactory), /invalid_api_credentials/);
const params = { AccountSid: account, CallSid: 'CA' + '1'.repeat(32) };
const url = 'https://example.invalid/api/missed-calls/alpha/ended';
assert.equal(validate(resolved.authToken, twilio.getExpectedTwilioSignature(auth, url, params), url, params), true);
assert.equal(validate(resolved.authToken, twilio.getExpectedTwilioSignature(apiSecret, url, params), url, params), false);
console.log('ok - environment and tenant credentials, account isolation, fail-closed key pairs, legacy compatibility, SDK auth and webhook signatures');
