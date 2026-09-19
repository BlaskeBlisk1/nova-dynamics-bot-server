"use strict";

// These URLs are compatibility identifiers, not display branding. Keep them so
// previously shared demos and embedded assistants survive the Jemlio rebrand.
const LEGACY_COMPANY_ORIGINS = Object.freeze([
  "https://nova-dynamics-bot-server.onrender.com",
  "https://prismatic-taffy-e96ac7.netlify.app",
  "https://nova-dynamics.no",
  "https://www.nova-dynamics.no",
  "http://localhost:8888",
  "http://localhost:3000",
  "http://localhost:5173"
]);

function isExactMarketingOrigin(value) {
  if (typeof value !== "string" || !value || value.includes("*")) return false;
  try {
    const url = new URL(value);
    // Origin equality rejects paths (including /), query, fragments, credentials
    // and noncanonical URLs. Never grant broad domain suffix or wildcard access.
    if (url.origin !== value || url.username || url.password) return false;
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

function parseMarketingOrigins(value = "") {
  return [...new Set(String(value).split(",").map(origin => origin.trim()).filter(isExactMarketingOrigin))];
}

function companyOrigins(env = process.env) {
  // Bad optional configuration must not take existing client demos offline.
  // Only add a domain here after its ownership and hosting have been verified.
  return [...new Set([...LEGACY_COMPANY_ORIGINS, ...parseMarketingOrigins(env.JEMLIO_MARKETING_ORIGINS)])];
}

module.exports = { LEGACY_COMPANY_ORIGINS, isExactMarketingOrigin, parseMarketingOrigins, companyOrigins };
