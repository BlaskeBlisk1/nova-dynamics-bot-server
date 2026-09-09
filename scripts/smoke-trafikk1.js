const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { app, publicDemoConfig } = require("../index");

const CLIENT = "trafikk1";
const RENDER_ORIGIN = "https://nova-dynamics-bot-server.onrender.com";
const SCHOOL_ORIGIN = "https://trafikk1trafikkskole.no";
const kbPath = path.join(process.cwd(), "clients", CLIENT, "kb.json");
const cssPath = path.join(process.cwd(), "public", "demo", "styles.css");
const demoAppPath = path.join(process.cwd(), "public", "demo", "app.js");
const kb = JSON.parse(fs.readFileSync(kbPath, "utf8"));
const css = fs.readFileSync(cssPath, "utf8");
const demoApp = fs.readFileSync(demoAppPath, "utf8");
const config = publicDemoConfig(CLIENT);

assert.ok(kb.length >= 80, `Expected at least 80 Trafikk1 entries, found ${kb.length}.`);
assert.equal(config.client, CLIENT);
assert.equal(config.name, "Trafikk1 Trafikkskole");
assert.match(config.website, /^https:\/\/trafikk1trafikkskole\.no\/?$/);
assert.equal(config.assistantInitial, "T1");
assert.equal(config.theme, "roadline");
assert.equal(config.accent.toLowerCase(), "#fbb831");
assert.notEqual(config.accent.toLowerCase(), "#e53935", "Do not reuse FRAM's red accent.");
assert.match(config.logo, /^https:\/\//);
assert.match(config.sourceTitle, /informasjon|opplysninger|kilder/i);
assert.match(config.sourceDescription, /offisielle nettside/i);
assert.ok(config.highlights.length >= 3);
assert.ok(config.suggestedQuestions.length >= 4);
assert.match(css, /body\[data-theme="roadline"\]/);
assert.match(demoApp, /function appendLinkedText/);
assert.match(demoApp, /link\.target = "_blank"/);
assert.match(demoApp, /link\.rel = "noreferrer"/);

for (const [index, entry] of kb.entries()) {
  assert.equal(typeof entry.q, "string", `Entry ${index} has no question.`);
  assert.equal(typeof entry.a, "string", `Entry ${index} has no answer.`);
  assert.ok(entry.q.trim().length > 4, `Entry ${index} has a short question.`);
  assert.ok(entry.a.trim().length > 12, `Entry ${index} has a short answer.`);
}

const serializedDemo = JSON.stringify({ kb, config }).toLowerCase();
assert.doesNotMatch(serializedDemo, /samler inn navn|lagrer kontakt(?:data|informasjon)|fanger leads?/);
assert.ok(
  kb.every(entry => !/(?:tilbyr|opplæring i).*\b(?:mc|motorsykkel|be|b96)\b/i.test(entry.a)),
  "The Trafikk1 knowledge base must not claim unsupported license classes."
);

const checks = [
  // Identity and contact.
  { message: "Hvor holder dere til?", includes: ["Kloppedalen 6", "1389 Heggedal"] },
  { message: "Hva er adressen?", includes: ["Kloppedalen 6", "1389 Heggedal"] },
  { message: "Ligger dere i Heggedal?", includes: ["Kloppedalen 6", "Heggedal"] },
  { message: "Ka e adressa?", includes: ["Kloppedalen 6"] },
  { message: "Hva er telefonnummeret?", includes: ["40 41 40 08"] },
  { message: "Kan jeg sende SMS?", includes: ["40 41 40 08", "utenom vanlig arbeidstid"] },
  { message: "Hva er e-posten deres?", includes: ["ge-nybr@online.no"] },
  { message: "Hvordan kontakter jeg dere?", includes: ["40 41 40 08", "ge-nybr@online.no", "/kontakt", "24 timer"] },
  { message: "Hva er nettsiden deres?", includes: ["https://trafikk1trafikkskole.no/"] },
  { message: "Hva er organisasjonsnummeret?", includes: ["934 224 353"] },
  { message: "Er dere en godkjent trafikkskole?", includes: ["godkjent av Statens vegvesen", "Norges Trafikkskoleforbund"] },
  { message: "Hvem er Garry?", includes: ["daglig leder", "trafikklærer"] },
  { message: "Hvem jobber der?", includes: ["Garry", "trafikklærer"] },
  { message: "Når har kontoret åpent?", includes: ["ikke spesifisert", "Faste kontortider"], unsure: true },
  { message: "Er kontoret åpent på lørdag?", includes: ["ikke spesifisert", "kontoret"], unsure: true },
  { message: "Hvor fort svarer dere?", includes: ["innen 24 timer", "kan variere"] },

  // Area, pickup and flexibility.
  { message: "Hvilke områder dekker dere?", includes: ["Røyken", "Asker", "Bærum"] },
  { message: "Henter dere meg i Asker?", includes: ["gratis", "Røyken", "Asker", "Bærum"] },
  { message: "Henter dere i Bærum?", includes: ["gratis", "Bærum"] },
  { message: "Kan dere hente meg i Røyken?", includes: ["gratis", "Røyken"] },
  { message: "Henter dere i Oslo?", includes: ["ikke spesifisert", "Røyken", "Asker", "Bærum"], unsure: true },
  { message: "Kan dere hente meg i Drammen?", includes: ["ikke spesifisert", "konkrete stedet"], unsure: true },
  { message: "Har dere gratis henting?", includes: ["gratis", "Røyken", "Asker", "Bærum"] },
  { message: "Kan jeg kjøre på kvelden?", includes: ["kveldstid", "Ledige tider"] },
  { message: "Har dere kjøretimer i helgen?", includes: ["helger", "Ledige tider"] },

  // Classes and transmission.
  { message: "Hvilke førerkortklasser tilbyr dere?", includes: ["klasse B", "automatgir", "Andre førerkortklasser"] },
  { message: "Tilbyr dere klasse B?", includes: ["klasse B", "automatgir"] },
  { message: "Har dere automat?", includes: ["automatgir", "klasse B"] },
  { message: "Tilbyr dere manuell?", includes: ["automatgir", "manuell", "ikke"], unsure: true },
  { message: "Har dere manuell eller MC?", includes: ["manuell opplæring", "MC er ikke oppført"], unsure: true },
  { message: "Kan jeg ta MC hos dere?", includes: ["ikke oppført"] },
  { message: "Tilbyr dere BE eller B96?", includes: ["ikke oppført"] },
  { message: "Kan jeg ta mopedlappen?", includes: ["ikke oppført"] },
  { message: "Har dere lastebilopplæring?", includes: ["ikke oppført"] },

  // Lesson prices and the published discrepancy.
  { message: "Hva koster en kjøretime?", includes: ["45-minutters", "750 kr", "850 kr", "1 100 kr", "800 kr"] },
  { message: "Hva koster en kjøretime på dagtid?", includes: ["45-minutters", "750 kr"] },
  { message: "Hva koster en kjøretime på kvelden?", includes: ["45-minutters", "850 kr"] },
  { message: "Hva koster en kjøretime i helgen?", includes: ["45-minutters", "1 100 kr"] },
  { message: "Hvor lenge varer en kjøretime?", includes: ["45 minutter"] },
  { message: "Hvorfor står det både 750 og 800 per time?", includes: ["750 kr", "800 kr", "ulike", "bekrefte"], unsure: true },
  { message: "Va koste kjøretima?", includes: ["750 kr", "850 kr", "1 100 kr"] },
  { message: "Kor mye koste kjøretime på kvelden?", includes: ["850 kr"] },

  // Packages and payment conditions.
  { message: "Hvilke pakketilbud har dere?", includes: ["7 200 kr", "14 400 kr", "23 750 kr"] },
  { message: "Hva koster pakken med 10 kjøretimer?", includes: ["7 200 kr", "10 × 800 kr", "800 kr"] },
  { message: "Hva koster 10 kjøretimer?", includes: ["7 200 kr", "10 × 800 kr"] },
  { message: "Hva koster pakken med 20 kjøretimer?", includes: ["14 400 kr", "20 × 800 kr", "1 600 kr"] },
  { message: "Hva koster 20 kjøretimer?", includes: ["14 400 kr", "20 × 800 kr"] },
  { message: "Hva koster obligatorisk pakke med 10 timer?", includes: ["23 750 kr", "25 750 kr", "2 000 kr"] },
  { message: "Kan jeg få pakken refundert?", includes: ["ikke", "refunderes", "overføres"] },
  { message: "Kan jeg overføre pakken til en venn?", includes: ["ikke", "overføres"] },
  { message: "Hvor lenge er pakken gyldig?", includes: ["12 måneder", "18 måneder"] },
  { message: "Garanterer pakken at jeg får lappen?", includes: ["Nei", "ikke", "garanti"] },
  { message: "Kan jeg betale med Vipps?", includes: ["kontanter", "Vipps", "TABS"] },
  { message: "Tar dere faktura?", includes: ["faktura", "TABS"] },
  { message: "Kan jeg betale med Klarna?", includes: ["ikke spesifisert", "Klarna"], unsure: true },
  { message: "Kan jeg dele opp betalingen?", includes: ["ikke spesifisert", "delbetaling"], unsure: true },

  // Courses and current status.
  { message: "Hva koster trafikalt grunnkurs?", includes: ["2 200 kr", "3 500 kr"] },
  { message: "Hva koster TGK med mørkekjøring?", includes: ["2 200 kr", "3 500 kr"] },
  { message: "Hva koster førstehjelp?", includes: ["1 900 kr", "2 200 kr"] },
  { message: "Hva koster mørkekjøring?", includes: ["2 400 kr", "3 500 kr"] },
  { message: "Hva koster førstehjelp og mørkekjøring?", includes: ["1 900 kr", "2 400 kr", "3 500 kr"] },
  { message: "Når er neste trafikale grunnkurs?", includes: ["utsatt inntil videre", "/kurs"], unsure: true },
  { message: "Hvilke kurs tilbyr dere?", includes: ["trafikalt grunnkurs", "førstehjelpskurs", "mørkekjøring", "utsatt inntil videre", "/kurs"] },
  { message: "Er kursene utsatt?", includes: ["publiserte kursene", "utsatt inntil videre", "/kurs"], unsure: true },
  { message: "Er det ledig plass på førstehjelpskurs?", includes: ["utsatt inntil videre", "/kurs"], unsure: true },
  { message: "Når er neste mørkekjøring?", includes: ["utsatt inntil videre", "/kurs"], unsure: true },
  { message: "Hvordan melder jeg meg på TGK?", includes: ["/kurs", "/kontakt", "kan ikke"], unsure: false },
  { message: "Kan du melde meg på grunnkurset?", includes: ["kan ikke", "/kontakt"] },
  { message: "Hva er trafikalt grunnkurs?", includes: ["første trinn", "17 undervisningstimer"] },
  { message: "Kan jeg ta trafikalt grunnkurs når jeg er 15?", includes: ["fra fylte 15 år", "utsatt inntil videre"] },
  { message: "Må jeg ta TGK når jeg er over 25?", includes: ["fylt 25 år", "fritatt", "Mørkekjøring", "førstehjelp"] },

  // The four-stage path and specialist prices.
  { message: "Hva er de fire trinnene?", includes: ["fire trinn", "trafikalt grunnkurs", "trafikal del", "avsluttende"] },
  { message: "Hva skjer på trinn 1?", includes: ["trafikalt grunnkurs", "17 undervisningstimer"] },
  { message: "Hva skjer på trinn 2?", includes: ["grunnleggende", "trinnvurdering"] },
  { message: "Hva skjer på trinn 3?", includes: ["variert trafikk", "fire timers", "øvingsbane"] },
  { message: "Hva skjer på trinn 4?", includes: ["avsluttende", "13 undervisningstimer"] },
  { message: "Hva koster sikkerhetskurs på bane?", includes: ["5 750 kr", "1 550 kr"] },
  { message: "Hva koster sikkerhetskurs på veg?", includes: ["1 500 kr", "4 900 kr", "3 900 kr", "11 800 kr"] },
  { message: "Hva koster NAF-banegebyret?", includes: ["1 550 kr"] },
  { message: "Hva koster 4.1.1?", includes: ["1 500 kr"] },
  { message: "Hva koster 4.1.2 dag 1?", includes: ["4 900 kr"] },
  { message: "Hva koster 4.1.3 dag 2?", includes: ["3 900 kr"] },
  { message: "Hva koster 4.1.4?", includes: ["1 500 kr"] },
  { message: "Hva koster leie av bil til oppkjøring?", includes: ["3 900 kr", "45 minutter", "forsikring"] },
  { message: "Hva koster oppkjøring?", includes: ["3 900 kr", "1 240 kr", "Statens vegvesen"], unsure: true },
  { message: "Hva koster oppkjøring på lørdag?", includes: ["4 900 kr", "Bekreft"], unsure: true },
  { message: "Hva koster teoriprøven?", includes: ["620 kr", "offentlig gebyr", "Statens vegvesen"], unsure: true },
  { message: "Hva er gebyret for praktisk prøve?", includes: ["1 240 kr", "Statens vegvesen"], unsure: true },
  { message: "Hva koster utstedelse av førerkort?", includes: ["340 kr", "Statens vegvesen"], unsure: true },
  { message: "Hva koster hele lappen?", includes: ["ikke én sikker totalpris", "NAF", "offentlige gebyrer"], unsure: true },
  { message: "Send lenke til prislisten", includes: ["https://trafikk1trafikkskole.no/priser"] },

  // Rules, cancellation and action limits.
  { message: "Hva er avbestillingsfristen?", includes: ["kl. 12", "siste virkedag", "tre virkedager"] },
  { message: "Når må en mandagstime avbestilles?", includes: ["fredag kl. 12"] },
  { message: "Når må obligatorisk opplæring avbestilles?", includes: ["tre virkedager"] },
  { message: "Hva skjer hvis jeg ikke møter?", includes: ["fullt"] },
  { message: "Hva skjer etter 12 måneder?", includes: ["12 måneder", "18 måneder"] },
  { message: "Kan jeg få pengene tilbake?", includes: ["ikke", "refunderes", "overføres"] },
  { message: "Er det noen skjulte gebyrer?", includes: ["NAF", "offentlige gebyrer", "kommer i tillegg"] },
  { message: "Hvem holder oversikt over bookede timer?", includes: ["eleven selv", "oversikt"] },
  { message: "Hva kreves for privat øvelseskjøring?", includes: ["16 år", "over 25 år", "fem år", "ekstra speil", "rød L"] },
  { message: "Hvor gammel må ledsager være?", includes: ["over 25 år", "fem år"] },
  { message: "Kan jeg bytte et utenlandsk førerkort?", includes: ["avhenger", "Statens vegvesen"], unsure: true },
  { message: "Hvordan søker jeg om førerkort?", includes: ["Statens vegvesen"] },
  { message: "Hva må jeg ha med til teoriprøven?", includes: ["gyldig legitimasjon", "synsattest", "Statens vegvesen"], unsure: true },
  { message: "Hvordan kommer jeg i gang?", includes: ["/kontakt", "40 41 40 08", "kan ikke utføre bestillingen"] },
  { message: "Kan jeg bestille via nettsiden?", includes: ["/kontakt", "kan ikke utføre bestillingen"] },
  { message: "Kan du booke en kjøretime for meg?", includes: ["kan ikke", "/kontakt"] },
  { message: "Book en kjøretime i morgen", includes: ["kan ikke", "/kontakt"] },
  { message: "Kan du sende en e-post til skolen?", includes: ["kan ikke sende e-post", "ge-nybr@online.no"] },
  { message: "Kan dere ringe meg tilbake?", includes: ["kan ikke lagre", "personopplysninger", "/kontakt"] },
  { message: "Jeg heter Ola og e-posten min er ola@example.com", includes: ["kan ikke lagre", "personopplysninger"], forbids: ["ola@example.com"] },
  { message: "Hvordan lagres chatten?", includes: ["lagrer ikke selve spørsmålet", "nettverksadresse"] },
  { message: "Hva kan du hjelpe med?", includes: ["klasse B", "henting", "pakker", "avbestilling"] },
  { message: "Hvorfor velge Trafikk1?", includes: ["gratis henting", "automatbiler", "kvelder", "helger"] },
  { message: "Takk for hjelpen!", includes: ["Bare hyggelig"] },
  { message: "Selger dere pizza?", includes: ["ikke et sikkert svar", "40 41 40 08"], unsure: true },

  // Regression checks for client isolation.
  { message: "Tilbyr dere snøscooter?", includes: ["ikke oppført"], forbids: ["Tiller", "Onsøy", "Fyllingsdalen"] },
  { message: "Ligger dere i Industriveien?", includes: ["ikke et sikkert svar"], forbids: ["Industriveien 3", "Heimdal"], unsure: true },
  { message: "Har dere Standardpakken?", includes: ["7 200 kr", "14 400 kr", "23 750 kr"], forbids: ["18 900 kr", "24 900 kr"] }
];

function folded(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase("nb-NO")
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

async function chat(baseUrl, message, options = {}) {
  const response = await fetch(`${baseUrl}/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Origin": options.origin || RENDER_ORIGIN,
      "X-Forwarded-For": options.ip || "198.51.100.10"
    },
    body: JSON.stringify({ client: options.client || CLIENT, message })
  });

  let body = {};
  try {
    body = await response.json();
  } catch {
    // Assertions below report response mismatches.
  }

  return { response, body };
}

const server = app.listen(0, async () => {
  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const failures = [];

    for (const [index, check] of checks.entries()) {
      const { response, body } = await chat(baseUrl, check.message, {
        ip: `198.51.${Math.floor(index / 240) + 150}.${(index % 240) + 10}`
      });
      const reply = folded(body.reply);
      const missing = check.includes.filter(expected => !reply.includes(folded(expected)));
      const forbidden = (check.forbids || []).filter(value => reply.includes(folded(value)));
      const unsureMismatch = typeof check.unsure === "boolean" && body.unsure !== check.unsure;

      if (response.status !== 200 || missing.length || forbidden.length || unsureMismatch) {
        failures.push(
          `Question "${check.message}" expected status 200 and ${JSON.stringify(check.includes)}` +
          `${typeof check.unsure === "boolean" ? ` with unsure=${check.unsure}` : ""}; ` +
          `got status ${response.status}, unsure=${body.unsure}, reply="${body.reply}"` +
          `${missing.length ? `, missing=${JSON.stringify(missing)}` : ""}` +
          `${forbidden.length ? `, leaked=${JSON.stringify(forbidden)}` : ""}.`
        );
      }
    }

    assert.deepEqual(failures, [], failures.join("\n"));

    const demoResponse = await fetch(`${baseUrl}/demos/${CLIENT}`);
    assert.equal(demoResponse.status, 200);
    assert.match(await demoResponse.text(), /id="chat-form"/);

    const configResponse = await fetch(`${baseUrl}/api/demo-config/${CLIENT}`);
    assert.equal(configResponse.status, 200);
    const routeConfig = await configResponse.json();
    assert.equal(routeConfig.client, CLIENT);
    assert.equal(routeConfig.name, "Trafikk1 Trafikkskole");
    assert.equal(routeConfig.theme, "roadline");

    const officialOrigin = await chat(baseUrl, "Hvor holder dere til?", {
      origin: SCHOOL_ORIGIN,
      ip: "203.0.113.60"
    });
    assert.equal(officialOrigin.response.status, 200);
    assert.equal(officialOrigin.response.headers.get("access-control-allow-origin"), SCHOOL_ORIGIN);

    const preflight = await fetch(`${baseUrl}/chat`, {
      method: "OPTIONS",
      headers: { Origin: SCHOOL_ORIGIN }
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), SCHOOL_ORIGIN);

    const rejectedOrigin = await chat(baseUrl, "Hei", {
      origin: "https://example.invalid",
      ip: "203.0.113.61"
    });
    assert.equal(rejectedOrigin.response.status, 403);

    const empty = await fetch(`${baseUrl}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client: CLIENT, message: "" })
    });
    assert.equal(empty.status, 400);

    const unknownClient = await chat(baseUrl, "Hei", {
      client: "not-a-real-client",
      ip: "203.0.113.62"
    });
    assert.equal(unknownClient.response.status, 400);

    for (const debugPath of ["/debug-kb?client=trafikk1", "/debug-cors", "/debug-intent?message=hei", "/debug-rank?client=trafikk1&message=pris"]) {
      const debugResponse = await fetch(`${baseUrl}${debugPath}`);
      assert.equal(debugResponse.status, 404, `${debugPath} must be disabled unless explicitly enabled.`);
      assert.deepEqual(await debugResponse.json(), { error: "Not found." });
    }

    console.log(`Trafikk1 smoke test passed (${checks.length} answer checks, ${kb.length} KB entries).`);
  } catch (error) {
    console.error(error.stack || error);
    process.exitCode = 1;
  } finally {
    server.close();
  }
});
