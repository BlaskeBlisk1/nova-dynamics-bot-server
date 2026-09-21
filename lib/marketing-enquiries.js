"use strict";

const express = require("express");
const crypto = require("crypto");

const DEFAULT_ALLOWED_ORIGINS = Object.freeze([
  "https://www.jemlio.com",
  "https://jemlio.com"
]);

function cleanText(value, max) {
  return String(value == null ? "" : value).replace(/\s+/g, " ").trim().slice(0, max);
}

function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 254;
}

function validateWebhookUrl(raw) {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.hostname !== "hooks.airtable.com") return null;
    if (!url.pathname.startsWith("/workflows/v1/genericWebhook/")) return null;
    if (url.username || url.password || url.hash) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function createMarketingEnquiryRouter({
  fetchImpl = global.fetch,
  now = Date.now,
  randomUUID = crypto.randomUUID,
  webhookUrl = process.env.JEMLIO_ENQUIRY_WEBHOOK_URL || "",
  allowedOrigins = DEFAULT_ALLOWED_ORIGINS
} = {}) {
  const router = express.Router();
  const target = validateWebhookUrl(webhookUrl);
  const allowed = new Set(allowedOrigins);
  const buckets = new Map();
  const WINDOW_MS = 10 * 60 * 1000;
  const MAX_REQUESTS = 6;

  router.use(express.urlencoded({ extended: false, limit: "16kb" }));

  function originAllowed(req) {
    const origin = String(req.headers.origin || "");
    if (origin) return allowed.has(origin);
    const referer = String(req.headers.referer || "");
    if (!referer) return false;
    try {
      return allowed.has(new URL(referer).origin);
    } catch {
      return false;
    }
  }

  function rateAllowed(req) {
    const at = now();
    const key = req.ip || req.socket?.remoteAddress || "unknown";
    let bucket = buckets.get(key);
    if (!bucket || at - bucket.startedAt >= WINDOW_MS) {
      bucket = { startedAt: at, count: 0 };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (buckets.size > 2000) {
      for (const [ip, value] of buckets) {
        if (at - value.startedAt >= WINDOW_MS) buckets.delete(ip);
      }
    }
    return bucket.count <= MAX_REQUESTS;
  }

  router.post("/", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Robots-Tag", "noindex, nofollow");

    if (!originAllowed(req)) return res.status(403).json({ error: "origin_not_allowed" });
    if (!rateAllowed(req)) {
      res.setHeader("Retry-After", "600");
      return res.status(429).json({ error: "too_many_requests" });
    }

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const honeypot = cleanText(body["bot-field"], 200);
    if (honeypot) {
      return res.status(202).json({ accepted: true });
    }

    const name = cleanText(body.name, 120);
    const email = cleanText(body.email, 254).toLowerCase();
    const company = cleanText(body.company, 300);
    const industry = cleanText(body.industry, 100);
    const message = cleanText(body.message, 1000);
    const contactRequest = body["contact-request"];
    const consent = contactRequest === true ||
      contactRequest === "true" ||
      contactRequest === "on" ||
      contactRequest === "1" ||
      String(contactRequest || "").includes("kontakt");

    if (!name || !company || !validEmail(email) || !consent) {
      return res.status(400).json({ error: "invalid_enquiry" });
    }
    if (!target || typeof fetchImpl !== "function") {
      return res.status(503).json({ error: "enquiry_unavailable" });
    }

    const receipt = randomUUID();
    const payload = {
      source: "Jemlio website",
      received: new Date(now()).toISOString(),
      name,
      email,
      phone: "",
      business: company,
      website: /^https?:\/\//i.test(company) ? company : "",
      industry,
      service: "gratis mini-demo",
      preferredContact: "email",
      consent: true,
      receipt,
      notes: message
    };

    try {
      const response = await fetchImpl(target, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(8000)
      });
      if (!response.ok) throw new Error("webhook_rejected");
    } catch {
      return res.status(503).json({ error: "enquiry_unavailable" });
    }

    const wantsJson = req.is("application/json") ||
      String(req.headers.accept || "").includes("application/json");
    if (wantsJson) return res.status(201).json({ accepted: true, receipt });
    return res.redirect(303, "https://www.jemlio.com/demo-requested");
  });

  return router;
}

module.exports = { createMarketingEnquiryRouter, validateWebhookUrl };
