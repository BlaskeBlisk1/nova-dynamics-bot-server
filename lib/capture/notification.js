const RETRY_WINDOW_MS = 23 * 60 * 60 * 1000;

// Sending is explicit. Importing this module never starts a worker or calls a provider.
function createResendNotifier({ apiKey, fetchFn = global.fetch, timeoutMs = 10_000 } = {}) {
  if (!apiKey || typeof fetchFn !== 'function') throw new Error('notification_not_configured');
  return async function sendNotification({ notification, idempotencyKey }) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchFn('https://api.resend.com/emails', {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify(notification)
      });
      const body = await response.json().catch(() => ({}));
      if (response.ok && typeof body.id === 'string' && body.id.length <= 200) return { providerId: body.id };
      const error = new Error('notification_provider_error');
      error.code = response.status === 409 && body.name === 'invalid_idempotent_request'
        ? 'payload_conflict' : `provider_${Number(response.status) || 'unknown'}`;
      error.retryable = response.status === 429 || response.status >= 500 ||
        (response.status === 409 && body.name === 'concurrent_idempotent_requests') || response.ok;
      throw error;
    } catch (error) {
      if (error.retryable !== undefined) throw error;
      const safeError = new Error('notification_uncertain');
      safeError.code = 'network_uncertain';
      safeError.retryable = true;
      throw safeError;
    } finally { clearTimeout(timeout); }
  };
}

async function flushNotifications({ store, sendNotification, isTenantEnabled, now = Date.now, limit = 10, idempotencyPrefix = 'nova-capture' } = {}) {
  if (!store || store.durable !== true || typeof sendNotification !== 'function' || typeof isTenantEnabled !== 'function') {
    throw new Error('durable_delivery_not_configured');
  }
  const results = [];
  for (let n = 0; n < Math.min(Math.max(limit, 0), 100); n++) {
    const claim = await store.claimNext(now());
    if (!claim) break;
    if (!await isTenantEnabled(claim.client, claim.notification, claim)) {
      await store.finish(claim, { status: 'needs_review', errorCode: 'tenant_disabled', at: now() });
      results.push({ receipt: claim.request_id, status: 'needs_review' });
      continue;
    }
    const first = new Date(claim.first_attempt_at).getTime();
    if (!Number.isFinite(first) || now() - first >= RETRY_WINDOW_MS) {
      await store.finish(claim, { status: 'needs_review', errorCode: 'retry_window_expired', at: now() });
      results.push({ receipt: claim.request_id, status: 'needs_review' });
      continue;
    }
    let result;
    try {
      result = await sendNotification({ notification: claim.notification, idempotencyKey: `${idempotencyPrefix}/${claim.request_id}` });
      if (!result || typeof result.providerId !== 'string' || !result.providerId) throw Object.assign(new Error('uncertain'), { retryable: true, code: 'provider_response_uncertain' });
    } catch (error) {
      const retry = error.retryable !== false;
      const delay = Math.min(60 * 60 * 1000, 30_000 * 2 ** Math.min(claim.attempts - 1, 7));
      const next = now() + delay;
      const status = !retry ? 'failed' : next - first >= RETRY_WINDOW_MS ? 'needs_review' : 'pending';
      // Only fixed internal codes, never a provider error message or response body (may contain PII).
      const code = /^(provider_\d{3}|network_uncertain|payload_conflict|provider_response_uncertain)$/.test(error.code || '') ? error.code : 'delivery_uncertain';
      await store.finish(claim, { status, errorCode: code, nextAttemptAt: next, at: now() });
      results.push({ receipt: claim.request_id, status });
      continue;
    }
    // If storing acceptance fails, keep the lease/claim intact. A later attempt uses
    // the SAME immutable provider payload and key, and stops before key expiry.
    const stored = await store.finish(claim, { status: 'accepted', providerId: result.providerId, at: now() });
    results.push({ receipt: claim.request_id, status: stored ? 'accepted' : 'claim_lost' });
  }
  return results;
}

module.exports = { createResendNotifier, flushNotifications, RETRY_WINDOW_MS };
