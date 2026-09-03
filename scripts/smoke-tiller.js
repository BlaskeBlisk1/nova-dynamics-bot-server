const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { app, publicDemoConfig } = require("../index");

const CLIENT = "tiller";
const RENDER_ORIGIN = "https://nova-dynamics-bot-server.onrender.com";
const SCHOOL_ORIGIN = "https://tillertrafikkskole.no";
const kbPath = path.join(process.cwd(), "clients", CLIENT, "kb.json");
const cssPath = path.join(process.cwd(), "public", "demo", "styles.css");
const demoAppPath = path.join(process.cwd(), "public", "demo", "app.js");
const kb = JSON.parse(fs.readFileSync(kbPath, "utf8"));
const css = fs.readFileSync(cssPath, "utf8");
const demoApp = fs.readFileSync(demoAppPath, "utf8");
const config = publicDemoConfig(CLIENT);

assert.ok(kb.length >= 65, `Expected at least 65 Tiller entries, found ${kb.length}.`);
assert.equal(config.client, CLIENT);
assert.equal(config.name, "Tiller Trafikkskole");
assert.match(config.website, /^https:\/\/tillertrafikkskole\.no\/?$/);
assert.equal(config.assistantInitial, "T");
assert.equal(config.theme, "nightdrive");
assert.notEqual(config.accent.toLowerCase(), "#e53935", "Do not reuse FRAM's red accent.");
assert.match(config.logo, /^https:\/\//);
assert.match(config.sourceTitle, /informasjon|opplysninger|kilder/i);
assert.match(config.sourceDescription, /offisielle nettside/i);
assert.ok(config.highlights.length >= 3);
assert.ok(config.suggestedQuestions.length >= 4);
assert.match(css, /body\[data-theme="nightdrive"\]/);
assert.match(demoApp, /function appendLinkedText/);
assert.match(demoApp, /link\.target = "_blank"/);
assert.match(demoApp, /link\.rel = "noreferrer"/);

for (const [index, entry] of kb.entries()) {
  assert.equal(typeof entry.q, "string", `Entry ${index} has no question.`);
  assert.equal(typeof entry.a, "string", `Entry ${index} has no answer.`);
  assert.ok(entry.q.trim().length > 4, `Entry ${index} has a short question.`);
  assert.ok(entry.a.trim().length > 12, `Entry ${index} has a short answer.`);
}

const serializedTiller = JSON.stringify({ kb, config }).toLowerCase();
assert.doesNotMatch(serializedTiller, /samler inn navn|lagrer kontakt(?:data|informasjon)|fanger leads?/);
assert.ok(
  kb.every(entry => !/(?:tilbyr|opplæring i).*(?:mc|motorsykkel)/i.test(entry.a)),
  "The Tiller knowledge base must not claim that the school offers motorcycle training."
);

const checks = [
  // Identity and published contact information.
  { message: "Hvor holder dere til?", includes: ["Industriveien 3", "7080 Heimdal"] },
  { message: "Hva er adressen deres?", includes: ["Industriveien 3", "7080 Heimdal"] },
  { message: "Ligger skolen på Heimdal?", includes: ["Industriveien 3", "Heimdal"] },
  { message: "Hva er telefonnummeret?", includes: ["96 84 73 41"] },
  { message: "Hva er e-posten deres?", includes: ["post@tillertrafikkskole.no"] },
  { message: "Hvordan kontakter jeg dere?", includes: ["96 84 73 41", "post@tillertrafikkskole.no", "/contact"] },
  { message: "Hva er nettsiden deres?", includes: ["https://tillertrafikkskole.no/"] },
  { message: "Når har kontoret åpent?", includes: ["ikke spesifisert", "ring før oppmøte"], unsure: true },
  { message: "Er dere åpne på lørdag?", includes: ["ikke spesifisert", "Faste åpningstider"], unsure: true },
  { message: "Hvem er Mohammad Alsayed?", includes: ["daglig leder", "trafikklærer"] },
  { message: "Hvem jobber hos dere?", includes: ["Mohammad Alsayed", "trafikklærer"] },

  // Tiller's actual published offering and profile.
  { message: "Hvilke førerkortklasser tilbyr dere?", includes: ["klasse B automat", "trafikalt grunnkurs"] },
  { message: "Har dere automat?", includes: ["klasse B automat", "moderne biler"] },
  { message: "Tilbyr dere manuell?", includes: ["automat", "manuelt gir", "ikke oppført"] },
  { message: "Tilbyr dere manuell eller MC?", includes: ["klasse B automat", "manuelt gir", "motorsykkel", "ikke oppført"] },
  { message: "Kan jeg ta MC hos dere?", includes: ["ikke oppført"], forbids: ["A1", "A2"] },
  { message: "Tilbyr dere BE eller B96?", includes: ["ikke oppført"] },
  { message: "Kan jeg ta mopedlappen hos dere?", includes: ["ikke oppført"] },
  { message: "Har dere lastebilopplæring?", includes: ["ikke oppført"] },
  { message: "Hvorfor velge Tiller Trafikkskole?", includes: ["moderne biler", "fleksible kjøretimer", "trygg veiledning"] },
  { message: "Hvilke språk underviser dere på?", includes: ["flere språk", "navngir ikke hvilke"] },
  { message: "Kan jeg få opplæring på engelsk?", includes: ["flere språk", "bekrefte språket"] },

  // Packages and published prices.
  { message: "Hva koster Standardpakken?", includes: ["18 900 kr", "trinnvurdering", "1 550 kr", "forhåndsbetales"] },
  { message: "Hva inkluderer Standardpakken?", includes: ["18 900 kr", "Lånke", "oppvarmingstime"] },
  { message: "Hva koster Superpakken?", includes: ["24 900 kr", "ti kjøretimer", "forhåndsbetales"] },
  { message: "Hva inkluderer Superpakken?", includes: ["ti kjøretimer", "sikkerhetskurs", "oppvarmingstime"] },
  { message: "Hva er forskjellen på Standardpakken og Superpakken?", includes: ["18 900 kr", "24 900 kr", "ti vanlige kjøretimer"] },
  { message: "Hvilke pakker har dere?", includes: ["Standardpakke", "18 900 kr", "Superpakke", "24 900 kr"] },
  { message: "Hva er ikke inkludert i pakkene?", includes: ["førstehjelp", "mørkekjøring", "1 490 kr", "1 550 kr"] },
  { message: "Må pakken betales på forhånd?", includes: ["må betales på forhånd"] },
  { message: "Kan jeg betale pakken med Vipps?", includes: ["ikke spesifisert", "forhåndsbetales", "betalingsmåte"], unsure: true },
  { message: "Hva koster en kjøretime?", includes: ["800 kr", "ikke spesifisert"] },
  { message: "Hva koster trinnvurdering 2?", includes: ["850 kr", "45 minutter"] },
  { message: "Hva koster trinnvurdering 3?", includes: ["1 000 kr", "60 minutter"] },
  { message: "Hva koster sikkerhetskurs på bane?", includes: ["4 600 kr", "1 550 kr", "Lånke"] },
  { message: "Hva koster NAF-banegebyret?", includes: ["1 550 kr"] },
  { message: "Hva koster sikkerhetskurs på veg?", includes: ["890 kr", "4 600 kr", "3 600 kr"] },
  { message: "Hva koster 4.1.1?", includes: ["890 kr", "Bilkjøringens risiko"] },
  { message: "Hva koster 4.1.2?", includes: ["4 600 kr", "landevegsmiljø"] },
  { message: "Hva koster 4.1.3?", includes: ["3 600 kr", "variert trafikkmiljø"] },
  { message: "Hva koster 4.1.4?", includes: ["890 kr", "Refleksjon"] },
  { message: "Hva koster leie av bil til oppkjøring?", includes: ["2 900 kr", "oppvarmingstime", "1 490 kr"] },
  { message: "Hva koster oppkjøringen?", includes: ["1 490 kr", "2 900 kr"] },
  { message: "Hva koster teoriprøven?", includes: ["480 kr", "Statens vegvesen"] },
  { message: "Hva er gebyret for utstedelse av førerkort?", includes: ["160 kr", "Statens vegvesen"] },
  { message: "Hva koster hele førerkortet?", includes: ["Totalprisen varierer", "18 900 kr", "24 900 kr", "tillegg"] },
  { message: "Send lenke til prisene", includes: ["https://tillertrafikkskole.no/priser"] },

  // Traffic basic course and the four-stage learning path.
  { message: "Hva koster trafikalt grunnkurs?", includes: ["2 900 kr", "førstehjelp", "mørkekjøring", "17"] },
  { message: "Hva koster TGK?", includes: ["2 900 kr", "17"] },
  { message: "Hva koster mørkekjøring?", includes: ["1 400 kr", "2 900 kr"] },
  { message: "Hva koster førstehjelp?", includes: ["800 kr", "2 900 kr"] },
  { message: "Hvor lenge varer TGK?", includes: ["17", "fem samlinger", "ti timer teori", "fire timer førstehjelp", "tre timer mørkekjøring"] },
  { message: "Hvor gammel må jeg være for TGK?", includes: ["15 år"] },
  { message: "Jeg er over 25, må jeg ta TGK?", includes: ["over 25", "trenger deler", "bekreftet"] },
  { message: "Når er neste grunnkurs?", includes: ["18.–21. september", "oppgir ikke år", "bekreft"] },
  { message: "Er det ledig plass på kurset 18-21 september?", includes: ["18.–21. september", "ledige plasser", "bekreft"] },
  { message: "Hvordan melder jeg meg på TGK?", includes: ["/contact", "96 84 73 41", "ledig plass"] },
  { message: "Når kan jeg ta mørkekjøring?", includes: ["1. november", "15. mars", "Statens vegvesen"] },
  { message: "Hva er de fire trinnene?", includes: ["fire trinn", "trafikalt grunnkurs", "trafikal del", "avsluttende"] },
  { message: "Hva skjer på trinn 2?", includes: ["styring", "bremsing", "trinnvurdering 2"] },
  { message: "Hva skjer på trinn 3?", includes: ["variert trafikk", "øvingsbane", "60 minutter"] },
  { message: "Hva skjer på trinn 4?", includes: ["sikkerhetskurs på veg", "landevegskjøring", "refleksjon"] },

  // Contact flow, unknown policies and data-safety behaviour.
  { message: "Hvordan kommer jeg i gang?", includes: ["/contact", "96 84 73 41", "post@tillertrafikkskole.no"] },
  { message: "Kan du booke en time for meg?", includes: ["kan ikke", "/contact"] },
  { message: "Send lenke til påmelding", includes: ["https://tillertrafikkskole.no/contact"] },
  { message: "Hva er avbestillingsfristen?", includes: ["ikke spesifisert", "Avbestillingsfrist"], unsure: true },
  { message: "Hvor lenge varer en vanlig kjøretime?", includes: ["ikke spesifisert", "ikke publisert", "45", "60"], unsure: true },
  { message: "Kan dere hente meg på skolen?", includes: ["ikke spesifisert", "faste hentesteder"], unsure: true },
  { message: "Kan dere ringe meg tilbake?", includes: ["kan ikke lagre", "personopplysninger", "96 84 73 41"] },
  { message: "Jeg heter Ola og e-posten min er ola@example.com", includes: ["kan ikke lagre", "personopplysninger"], forbids: ["ola@example.com"] },
  { message: "Telefonnummeret mitt er 91234567", includes: ["kan ikke lagre", "personopplysninger"], forbids: ["91234567"] },
  { message: "Hvordan behandles dataene mine?", includes: ["lagrer ikke selve spørsmålet", "nettverksadresse"] },
  { message: "Hvordan lagres chatten?", includes: ["lagrer ikke selve spørsmålet", "nettverksadresse"] },
  { message: "Hva kan du hjelpe meg med?", includes: ["klasse B automat", "trafikalt grunnkurs", "priser"] },
  { message: "Takk for hjelpen!", includes: ["Bare hyggelig"] },
  { message: "Selger dere pizza?", includes: ["ikke et sikkert svar", "96 84 73 41"], unsure: true },

  // Regression coverage for natural phrasing, combined intents and action limits.
  { message: "Kan æ ta grunnkurset når æ e 14?", includes: ["ikke ennå", "15 år"], forbids: ["18.–21. september"] },
  { message: "Kan 14-åringer ta trafikalt grunnkurs?", includes: ["ikke ennå", "15 år"] },
  { message: "Kan en 15-åring ta TGK?", includes: ["fra fylte 15 år"] },
  { message: "Må en 26-åring ta trafikalt grunnkurs?", includes: ["over 25 år", "bare trenger deler"] },
  { message: "E æ fritatt når æ e 26?", includes: ["over 25 år", "bare trenger deler"] },
  { message: "Jeg er 25 år, må jeg ta trafikalt grunnkurs?", includes: ["ikke spesifisert", "over 25 år", "akkurat når du er 25"], unsure: true },
  { message: "Må jeg ta TGK når jeg er 25?", includes: ["ikke spesifisert", "over 25 år", "akkurat når du er 25"], unsure: true },
  { message: "Når kan jeg øvelseskjøre etter trafikalt grunnkurs?", includes: ["første trinn", "nødvendig dokumentasjon"], forbids: ["18.–21. september"] },
  { message: "Jeg fyller 18. september, kan jeg ta førerkort?", includes: ["klasse B automat"], forbids: ["18.–21. september"] },
  { message: "Jeg fyller 18. september, kan jeg ta trafikalt grunnkurs?", includes: ["17 undervisningstimer"], forbids: ["18.–21. september"] },
  { message: "Er det ledige plasser for kjøretimer?", includes: ["ikke spesifisert", "Ledige kjøretimer"], unsure: true },
  { message: "Hva koster grunnkurset 18.–21. september?", includes: ["2 900 kr", "18.–21. september", "oppgir ikke år"], unsure: true },
  { message: "Hva koster grunnkurset uten mørkekjøring?", includes: ["2 900 kr", "egen pris", "ikke publisert"], unsure: true },
  { message: "Kan jeg bestille time her i chatten?", includes: ["kan ikke bestille", "/contact"] },
  { message: "Book en kjøretime til meg i morgen", includes: ["kan ikke bestille", "/contact"] },
  { message: "Kan jeg melde meg på kurset 18. september her?", includes: ["kan ikke", "melde deg på kurs", "/contact"] },
  { message: "Kan du avbestille kjøretimen for meg?", includes: ["ikke spesifisert", "Avbestillingsfrist"], unsure: true },
  { message: "Hvordan bestiller jeg klasse B?", includes: ["/contact", "kan ikke utføre bestillingen"] },
  { message: "Hvordan kommer jeg i gang med klasse B?", includes: ["/contact", "kan ikke utføre bestillingen"] },
  { message: "Kan jeg bestille en kjøretime på nettsiden?", includes: ["kan ikke bestille", "/contact"] },
  { message: "Kan du sende meg en epost?", includes: ["kan ikke sende e-post", "post@tillertrafikkskole.no"] },
  { message: "Send e-post til skolen for meg", includes: ["kan ikke sende e-post", "post@tillertrafikkskole.no"] },
  { message: "Kan dere sende svar til post@tillertrafikkskole.no?", includes: ["kan ikke sende e-post"] },
  { message: "Har dere Facebook?", includes: ["ikke et sikkert svar"], forbids: ["bestillingen"], unsure: true },
  { message: "Kan du finne Facebook-siden deres for meg?", includes: ["ikke et sikkert svar"], forbids: ["kan ikke bestille"], unsure: true },
  { message: "Hvordan betaler jeg pakken?", includes: ["ikke spesifisert", "forhåndsbetales", "betalingsmåte"], unsure: true },
  { message: "Må jeg betale før kjøretimen?", includes: ["ikke spesifisert", "betalingsmåte"], unsure: true },
  { message: "Kan jeg betale etter timen?", includes: ["ikke spesifisert", "betalingsmåte"], unsure: true },
  { message: "Kan jeg dele opp betalingen?", includes: ["ikke spesifisert", "delbetaling"], unsure: true },
  { message: "Tar dere Klarna?", includes: ["ikke spesifisert", "betalingsmåte"], unsure: true },
  { message: "Hva er kort forklart trafikalt grunnkurs?", includes: ["17 undervisningstimer"], forbids: ["betalingsmåte"] },
  { message: "Er kjøretimer med i Standardpakken?", includes: ["ikke oppført", "Superpakken", "ti kjøretimer"] },
  { message: "Inkluderer Standardpakken 10 kjøretimer?", includes: ["ikke oppført", "Superpakken", "ti kjøretimer"] },
  { message: "Hvor mye blir Standardpakken med alle gebyrer?", includes: ["ikke oppgis én komplett totalsum", "18 900 kr", "1 490 kr", "1 550 kr"] },
  { message: "Hva koster førstehjelp og mørkekjøring?", includes: ["800 kr", "1 400 kr"] },
  { message: "Hva koster TGK og en kjøretime?", includes: ["2 900 kr", "800 kr"] },
  { message: "Hva koster mørkekjøring i TGK?", includes: ["2 900 kr", "1 400 kr"] },
  { message: "Hva koster det å bestille en kjøretime?", includes: ["800 kr"] },
  { message: "Hva koster det å melde seg på TGK?", includes: ["2 900 kr"] },
  { message: "Hva koster det å bestille Standardpakken?", includes: ["18 900 kr"] },
  { message: "Hva koster hele trinn 3?", includes: ["ikke spesifisert", "totalpris for hele opplæringstrinnet", "1 000 kr"], unsure: true },
  { message: "Hvor lenge varer sikkerhetskurs på bane?", includes: ["fire timer", "Lånke"] },
  { message: "Hvor lenge varer sikkerhetskurs på veg?", includes: ["13 undervisningstimer", "fire deler"] },
  { message: "Hvor lenge varer mørkekjøring?", includes: ["tre undervisningstimer"] },
  { message: "Hvor lenge varer førstehjelpskurset?", includes: ["fire undervisningstimer"] },
  { message: "Va koste en kjøretime?", includes: ["800 kr"] },
  { message: "kor mye koste en kjøretime hos dokker?", includes: ["800 kr"] },
  { message: "Hva koste standard?", includes: ["18 900 kr"] },
  { message: "Hva koste trinnvurdering to?", includes: ["850 kr"] },
  { message: "Hva koste trinnvurdering tre?", includes: ["1 000 kr"] },
  { message: "ka koster kjøretima?", includes: ["800 kr"] },
  { message: "Æ vil ta lappen. Ka gjør æ?", includes: ["/contact", "kan ikke utføre bestillingen"] },
  { message: "Kor e skolen?", includes: ["Industriveien 3", "7080 Heimdal"] },
  { message: "Hvor e dokker hen?", includes: ["Industriveien 3", "7080 Heimdal"] },
  { message: "Ka e adressa?", includes: ["Industriveien 3", "7080 Heimdal"] },
  { message: "E dokker åpen no?", includes: ["ikke spesifisert", "Faste åpningstider"], unsure: true },
  { message: "Hvem er lærern?", includes: ["Mohammad Alsayed", "trafikklærer"] },
  { message: "Koffer ska æ velge dokker?", includes: ["moderne biler", "fleksible kjøretimer", "trygg veiledning"] }
  , { message: "Ligger dere ved McDonalds?", includes: ["ikke et sikkert svar"], forbids: ["Motorsykkelopplæring"], unsure: true }
  , { message: "Er det åpenbart at dere bare har automat?", includes: ["klasse B automat"], forbids: ["Faste åpningstider"], unsure: false }
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
    // Assertions below report any response mismatch.
  }

  return { response, body };
}

const server = app.listen(0, async () => {
  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const failures = [];

    for (const [index, check] of checks.entries()) {
      const { response, body } = await chat(baseUrl, check.message, {
        ip: `198.51.${Math.floor(index / 240) + 100}.${(index % 240) + 10}`
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
    assert.equal(routeConfig.name, "Tiller Trafikkskole");
    assert.equal(routeConfig.theme, "nightdrive");

    const officialOrigin = await chat(baseUrl, "Hvor holder dere til?", {
      origin: SCHOOL_ORIGIN,
      ip: "203.0.113.10"
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
      ip: "203.0.113.11"
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
      ip: "203.0.113.12"
    });
    assert.equal(unknownClient.response.status, 400);

    for (const debugPath of ["/debug-kb?client=tiller", "/debug-cors", "/debug-intent?message=hei", "/debug-rank?client=tiller&message=pris"]) {
      const debugResponse = await fetch(`${baseUrl}${debugPath}`);
      assert.equal(debugResponse.status, 404, `${debugPath} must be disabled unless explicitly enabled.`);
      assert.deepEqual(await debugResponse.json(), { error: "Not found." });
    }

    console.log(`Tiller smoke test passed (${checks.length} answer checks, ${kb.length} KB entries).`);
  } catch (error) {
    console.error(error.stack || error);
    process.exitCode = 1;
  } finally {
    server.close();
  }
});
