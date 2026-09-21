'use strict';
// Temporary release helper. The private key never leaves this job's temporary
// directory. The repository receives only a run-bound encrypted envelope.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const SITE = '8fddfa2f-2643-4bb9-b40f-39d5216ce675';
const REPO = 'BlaskeBlisk1/nova-dynamics-bot-server';
const BRANCH = 'codex/jemlio-release-verification';
const temp = process.env.RUNNER_TEMP;
if (!temp || process.env.GITHUB_REPOSITORY !== REPO || process.env.GITHUB_REF_NAME !== BRANCH) throw new Error('Unexpected deployment environment');
const privatePath = path.join(temp, 'jemlio-private-session.pem');
const publicPath = path.join(temp, 'jemlio-public-session.json');
const resultPath = path.join(temp, 'jemlio-netlify-result.json');
const runId = process.env.GITHUB_RUN_ID;
const sourceCommit = process.env.GITHUB_SHA;
const aad = Buffer.from(`${runId}:${sourceCommit}:${SITE}`);

async function main() {
  if (process.argv[2] === 'prepare') {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 3072,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    });
    fs.writeFileSync(privatePath, privateKey, { mode: 0o600, flag: 'wx' });
    fs.writeFileSync(publicPath, JSON.stringify({ runId, sourceCommit, siteId: SITE, publicKey,
      keyFingerprint: crypto.createHash('sha256').update(publicKey).digest('hex'),
      expiresAt: Date.now() + 15 * 60 * 1000 }, null, 2));
    console.log('Ephemeral public session prepared. No credentials or private key are published.');
    return;
  }
  if (process.argv[2] !== 'deploy') throw new Error('Unknown operation');
  const session = JSON.parse(fs.readFileSync(publicPath, 'utf8'));
  let envelope;
  const target = `https://api.github.com/repos/${REPO}/contents/.github/deploy-inputs/${runId}.json?ref=${encodeURIComponent(BRANCH)}`;
  for (let attempt = 0; attempt < 96; attempt++) {
    const response = await fetch(target, { headers: { Authorization: `Bearer ${process.env.GH_READ_TOKEN}`, Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15000) });
    if (response.status === 200) {
      const file = await response.json();
      if (file.encoding !== 'base64' || file.size > 12000) throw new Error('Invalid envelope file');
      envelope = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
      break;
    }
    if (response.status !== 404) throw new Error('Envelope read failed');
    await delay(5000);
  }
  if (!envelope || Date.now() > session.expiresAt || envelope.keyFingerprint !== session.keyFingerprint) throw new Error('Session missing or expired');
  const key = crypto.privateDecrypt({ key: fs.readFileSync(privatePath), oaepHash: 'sha256', padding: crypto.constants.RSA_PKCS1_OAEP_PADDING }, Buffer.from(envelope.wrappedKey, 'base64'));
  fs.rmSync(privatePath);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
  decipher.setAAD(aad);
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  const payload = JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]).toString('utf8'));
  key.fill(0);
  if (payload.runId !== runId || payload.sourceCommit !== sourceCommit || payload.siteId !== SITE || !Number.isFinite(payload.expiresAt) || Date.now() > payload.expiresAt || payload.expiresAt > session.expiresAt) throw new Error('Envelope binding failed');
  const proxy = new URL(payload.proxyUrl);
  if (proxy.origin !== 'https://netlify-mcp.netlify.app' || !/^\/proxy\/[A-Za-z0-9_.-]+$/.test(proxy.pathname) || proxy.search || proxy.hash || proxy.username || proxy.password) throw new Error('Unexpected deployment proxy');
  console.log(`::add-mask::${payload.proxyUrl}`);
  console.log(`::add-mask::${proxy.pathname.slice('/proxy/'.length)}`);
  const redact = value => String(value).split(payload.proxyUrl).join('[REDACTED]').split(proxy.pathname.slice('/proxy/'.length)).join('[REDACTED]');
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/TOKEN|SECRET|PASSWORD|^ACTIONS_|^GH_READ_/i.test(name)));
  env.CI = 'true';
  env.NETLIFY_TELEMETRY_DISABLED = '1';
  let output = '';
  const result = await new Promise(resolve => {
    const child = spawn('npx', ['-y', '@netlify/mcp@latest', '--site-id', SITE, '--proxy-path', payload.proxyUrl], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 360000 });
    child.stdout.on('data', data => { if (output.length < 1000000) output += data.toString(); });
    child.stderr.on('data', data => { if (output.length < 1000000) output += data.toString(); });
    child.once('error', () => resolve({ exitCode: 1, signal: null }));
    child.once('close', (exitCode, signal) => resolve({ exitCode, signal }));
  });
  const safeOutput = redact(output);
  fs.writeFileSync(resultPath, JSON.stringify({ runId, sourceCommit, siteId: SITE, ...result, finishedAt: new Date().toISOString(), output: safeOutput }, null, 2));
  console.log(safeOutput);
  if (result.exitCode !== 0) throw new Error('Netlify deployment command failed');
}
main().catch(() => { console.error('Deployment session did not complete; no credentials printed.'); process.exitCode = 1; });
