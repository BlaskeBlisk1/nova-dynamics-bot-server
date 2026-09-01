const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { app, publicDemoConfig } = require("../index");

const kbPath = path.join(process.cwd(), "clients", "fram", "kb.json");
const kb = JSON.parse(fs.readFileSync(kbPath, "utf8"));
const config = publicDemoConfig("fram");

assert.ok(kb.length >= 90, `Expected at least 90 FRAM entries, found ${kb.length}.`);
assert.equal(config.name, "Fram Trafikkskole");
assert.equal(config.website, "https://framtrafikkskole.no");
assert.ok(config.suggestedQuestions.length >= 5);

for (const [index, entry] of kb.entries()) {
  assert.equal(typeof entry.q, "string", `Entry ${index} has no question.`);
  assert.equal(typeof entry.a, "string", `Entry ${index} has no answer.`);
  assert.ok(entry.q.trim().length > 4, `Entry ${index} has a short question.`);
  assert.ok(entry.a.trim().length > 12, `Entry ${index} has a short answer.`);
}

const combined = JSON.stringify(kb).toLowerCase();
assert.doesNotMatch(combined, /samle inn navn|lagre kontakt|fange lead|lead capture/);

const checks = [
  ["Hva koster mørkekjøring?", "1 850 kr"],
  ["Hva koster trafikalt grunnkurs med førstehjelp?", "2 690 kr"],
  ["Hva koster en kjøretime for klasse B?", "950 kr"],
  ["Hvor holder dere til?", "Kongeveien 47"],
  ["Når er kontoret åpent?", "fredager kl. 12.15–13.45"],
  ["Hva koster oppkjøring for BE?", "3 900 kr"],
  ["Hva koster MC A2 kjøretime?", "1 190 kr"],
  ["Hvilke klasser tilbyr dere?", "trafikalt grunnkurs"],
  ["Hvordan melder jeg meg på?", "bestillingssiden"],
  ["Hva koster Fram Total?", "37 400 kr"],
  ["Hva er forskjellen på BE og B96?", "totalvekt"],
  ["Hva er e-postadressen?", "post@framtrafikkskole.no"]
];

const server = app.listen(0, async () => {
  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    for (const [message, expected] of checks) {
      const response = await fetch(`${baseUrl}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client: "fram", message })
      });
      const body = await response.json();

      assert.equal(response.status, 200, `Unexpected status for: ${message}`);
      assert.ok(
        body.reply.includes(expected),
        `Question \"${message}\" expected \"${expected}\", got \"${body.reply}\".`
      );
    }

    console.log(`✅ FRAM knowledge base passed ${checks.length} answer checks across ${kb.length} entries.`);
  } finally {
    server.close();
  }
});
