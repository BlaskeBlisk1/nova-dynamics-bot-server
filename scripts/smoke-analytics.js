const fs = require("fs");
const path = require("path");

const appPath = path.join(__dirname, "..", "public", "demo", "app.js");
const source = fs.readFileSync(appPath, "utf8");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(source.includes('$process_person_profile: false'), "PostHog events must not create person profiles.");
assert(source.includes('https://eu.i.posthog.com/i/v0/e/'), "PostHog events must use the connected EU Cloud ingestion endpoint.");
assert(!source.includes('https://us.i.posthog.com/i/v0/e/'), "US ingestion endpoint must not be used for the EU Cloud project.");
assert(source.includes('const analyticsDistinctId'), "Anonymous per-page analytics ID is missing.");
assert(source.includes('"demo_opened"'), "demo_opened event is missing.");
assert(source.includes('"question_submitted"'), "question_submitted event is missing.");
assert(source.includes('"answer_success"'), "answer_success event is missing.");
assert(source.includes('"answer_fallback"'), "answer_fallback event is missing.");
assert(source.includes('"answer_error"'), "answer_error event is missing.");
assert(source.includes('"business_website_clicked"'), "Website conversion event is missing.");
assert(source.includes('"answer_link_clicked"'), "Answer link conversion event is missing.");
assert(!source.includes("question_text"), "Raw question text must never be sent to analytics.");

const analyticsStart = source.indexOf("function captureAnalytics");
const analyticsEnd = source.indexOf("function classifyQuestion");
assert(analyticsStart >= 0 && analyticsEnd > analyticsStart, "Analytics helper boundaries were not found.");
const analyticsHelper = source.slice(analyticsStart, analyticsEnd);
assert(!analyticsHelper.includes("message"), "Analytics helper must not accept or transmit chat messages.");

new Function(source);
console.log("Analytics smoke checks passed.");
