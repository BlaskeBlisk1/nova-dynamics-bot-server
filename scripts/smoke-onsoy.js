const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { app, publicDemoConfig } = require("../index");

const CLIENT = "onsoy";
const RENDER_ORIGIN = "https://nova-dynamics-bot-server.onrender.com";
const SCHOOL_ORIGIN = "https://onsoytrafikkskole.no";
const kbPath = path.join(process.cwd(), "clients", CLIENT, "kb.json");
const demoAppPath = path.join(process.cwd(), "public", "demo", "app.js");
const kb = JSON.parse(fs.readFileSync(kbPath, "utf8"));
const demoApp = fs.readFileSync(demoAppPath, "utf8");
const config = publicDemoConfig(CLIENT);

assert.ok(kb.length >= 50, `Expected at least 50 Onsøy entries, found ${kb.length}.`);
assert.equal(config.client, CLIENT);
assert.equal(config.name, "Onsøy Trafikkskole");
assert.match(config.website, /^https:\/\/onsoytrafikkskole\.no\/?$/);
assert.equal(config.assistantInitial, "O");
assert.notEqual(config.accent.toLowerCase(), "#e53935", "Do not reuse FRAM's red accent.");
assert.match(config.logo, /^https:\/\//);
assert.match(config.sourceTitle, /kilder|informasjon|opplysninger/i);
assert.match(config.sourceDescription, /TABS/i);
assert.ok(config.highlights.length >= 3);
assert.ok(config.suggestedQuestions.length >= 4);
assert.match(demoApp, /function appendLinkedText/);
assert.match(demoApp, /link\.target = "_blank"/);
assert.match(demoApp, /link\.rel = "noreferrer"/);

for (const [index, entry] of kb.entries()) {
  assert.equal(typeof entry.q, "string", `Entry ${index} has no question.`);
  assert.equal(typeof entry.a, "string", `Entry ${index} has no answer.`);
  assert.ok(entry.q.trim().length > 4, `Entry ${index} has a short question.`);
  assert.ok(entry.a.trim().length > 12, `Entry ${index} has a short answer.`);
}

assert.doesNotMatch(
  JSON.stringify({ kb, config }).toLowerCase(),
  /samler inn navn|lagrer kontakt(?:data|informasjon)|fanger leads?|lead capture|booker automatisk/
);

const checks = [
  // School, locations and contact details.
  { message: "Hvor holder dere til?", includes: ["Freskoveien 16", "1605 Fredrikstad"] },
  { message: "Hva er besøksadressen?", includes: ["Freskoveien 16"] },
  { message: "Ligger skolen i Fredrikstad sentrum?", includes: ["Fredrikstad"] },
  { message: "Hvilket bygg finner jeg dere i?", includes: ["Family treningssenter"] },
  { message: "Hvor ligger MC-avdelingen?", includes: ["FMV"] },
  { message: "Har MC-avdelingen en oppgitt gateadresse?", includes: ["FMV", "ikke publisert"] },
  { message: "Hva er telefonnummeret?", includes: ["92 98 99 98"] },
  { message: "Er telefonen 92989998?", includes: ["92 98 99 98"], forbids: ["personopplysninger"] },
  { message: "Hva er e-postadressen?", includes: ["post@onsoytrafikkskole.no"] },
  { message: "Er post@onsoytrafikkskole.no riktig e-post?", includes: ["post@onsoytrafikkskole.no"], forbids: ["personopplysninger"] },
  { message: "Hva er mailen deres?", includes: ["post@onsoytrafikkskole.no"] },
  { message: "Hvordan kontakter jeg dere?", includes: ["92 98 99 98", "post@onsoytrafikkskole.no"] },
  { message: "Hva er nettsiden deres?", includes: ["https://onsoytrafikkskole.no"] },
  { message: "Når er kontoret åpent?", includes: ["mandag", "torsdag", "09.00", "15.00"] },
  { message: "Er kontoret åpent på tirsdag?", includes: ["mandag", "torsdag", "09.00", "15.00"] },
  { message: "Er kontoret åpent på fredag?", includes: ["mandag", "torsdag", "09.00", "15.00"] },
  { message: "Når stenger dere?", includes: ["15.00"] },

  // Published offer and safe exclusions.
  { message: "Hvilke førerkortklasser tilbyr dere?", includes: ["B", "A1", "A2", "A"] },
  { message: "Tilbyr dere både manuell og automat?", includes: ["manu", "automat"] },
  { message: "Kan jeg ta klasse B automat hos dere?", includes: ["klasse B", "automat"] },
  { message: "Har dere opplæring på motorsykkel?", includes: ["A1", "A2", "A"] },
  { message: "Har dere MC?", includes: ["A1", "A2", "A"] },
  { message: "Tilbyr dere MC?", includes: ["A1", "A2", "A"] },
  { message: "Tar dere A2?", includes: ["A1", "A2", "A"] },
  { message: "Kan jeg få opplæring i A2?", includes: ["A1", "A2", "A"] },
  { message: "Tar dere klasse A?", includes: ["klasse A", "tung motorsykkel"] },
  { message: "Har dere bil?", includes: ["klasse B", "manuelt", "automat"] },
  { message: "Tar dere klasse B?", includes: ["klasse B", "manuelt", "automat"] },
  { message: "Kan jeg få opplæring i klasse B?", includes: ["klasse B", "manuelt", "automat"] },
  { message: "Har dere automat?", includes: ["klasse B", "automat"] },
  { message: "Hvilke MC-klasser har dere?", includes: ["A1", "A2", "A"] },
  { message: "Hva slags sertifikat kan jeg ta?", includes: ["B", "A1", "A2", "A"] },
  { message: "Kan jeg gå fra A1 til A2 hos dere?", includes: ["A1", "A2"] },
  { message: "Tilbyr dere overgang fra A2 til A?", includes: ["A2", "A"] },
  { message: "Tilbyr dere BE eller B96?", includes: ["ikke oppført"] },
  { message: "Kan jeg ta mopedlappen hos dere?", includes: ["ikke oppført"] },
  { message: "Har dere lastebilopplæring?", includes: ["ikke oppført"] },

  // Published age and class definitions.
  { message: "Hva er aldersgrensen for A1?", includes: ["16 år"] },
  { message: "Hvor gammel må jeg være for A2?", includes: ["18 år"] },
  { message: "Hva er aldersgrensen for klasse A?", includes: ["24 år"] },
  { message: "Jeg er 26, må jeg ta TGK?", includes: ["fritatt", "førstehjelp", "Trafikant i mørket"] },
  { message: "Kan jeg ta A når jeg er 20 og har hatt A2 i to år?", includes: ["20 år", "minst to år", "A2", "klasse A"] },
  { message: "Kan jeg ta A når jeg er 23 uten A2?", includes: ["24 år", "to år med A2"] },
  { message: "Hvor gammel må jeg være for lett MC?", includes: ["16 år"] },
  { message: "Hvor gammel må jeg være for mellomtung motorsykkel?", includes: ["18 år"] },
  { message: "Hvor gammel må jeg være for tung MC?", includes: ["24 år"] },
  { message: "Hva kan jeg kjøre med A1?", includes: ["125 ccm", "11 kW", "0,1"] },
  { message: "Hva betyr mellomtung motorsykkel i A2?", includes: ["35 kW", "0,2"] },
  { message: "Må jeg ta førerprøve for A2?", includes: ["obligatorisk opplæring", "førerprøve"] },

  // Unambiguous prices from the school's current TABS price list.
  { message: "Hva koster en kjøretime for klasse B?", includes: ["930 kr"] },
  { message: "Hva koster en kjøretime?", includes: ["930 kr", "1 160 kr", "Oppgi klasse"] },
  { message: "Hva må jeg betale for en kjøretime?", includes: ["930 kr", "1 160 kr"] },
  { message: "B time pris?", includes: ["930 kr"], forbids: ["ikke én samlet pris"] },
  { message: "A time pris?", includes: ["1 160 kr"], forbids: ["ikke én samlet pris"] },
  { message: "Hva koster en kjøretime for bil og MC?", includes: ["930 kr", "1 160 kr"] },
  { message: "Hva koster en time på motorsykkel?", includes: ["1 160 kr"] },
  { message: "Hva koster en automat-time for klasse B?", includes: ["930 kr"] },
  { message: "Hva koster en kjøretime for klasse automat?", includes: ["930 kr"], forbids: ["1 160 kr"] },
  { message: "Hva koster trinnvurdering trinn 2 for klasse B?", includes: ["930 kr"] },
  { message: "Hva koster trinnvurdering trinn 2?", includes: ["930 kr", "1 160 kr", "Oppgi"] },
  { message: "Hva koster trinnvurdering trinn 3 for klasse B?", includes: ["1 220 kr"] },
  { message: "Hva koster sikkerhetskurs på øvingsbane for bil?", includes: ["6 650 kr", "NAF"] },
  { message: "Hva koster sikkerhetskurs på veg for klasse B?", includes: ["11 375 kr"] },
  { message: "Hva koster sikkerhetskurs på veg?", includes: ["11 375 kr", "5 800 kr", "9 100 kr"] },
  { message: "Hva koster sikkerhetskurs på veg for A1?", includes: ["5 800 kr"] },
  { message: "Hva koster sikkerhetskurs på veg for lett MC?", includes: ["5 800 kr"] },
  { message: "Hva koster sikkerhetskurs på veg for mellomtung MC?", includes: ["5 800 kr"] },
  { message: "Hva koster sikkerhetskurs på veg for A1 og klasse A?", includes: ["5 800 kr", "9 100 kr"] },
  { message: "Hva koster sikkerhetskurs på veg for klasse A?", includes: ["9 100 kr"] },
  { message: "Hva koster sikkerhetskurs i presis kjøreteknikk for A2?", includes: ["7 250 kr"] },
  { message: "Hva koster presis kjøreteknikk for tung MC?", includes: ["7 250 kr"] },
  { message: "Hva koster oppkjøring med oppvarming og leie av bil?", includes: ["4 450 kr", "90"] },
  { message: "Hva koster oppkjøring?", includes: ["4 450 kr", "5 100 kr", "5 110 kr"] },
  { message: "Hva koster kjøring i landeveismiljø?", includes: ["4 725 kr"] },
  { message: "Hva koster planlegging og kjøring i variert miljø?", includes: ["3 750 kr"] },
  { message: "Hva koster førstehjelpskurset?", includes: ["875 kr"] },
  { message: "Hva koster mørkekjøring?", includes: ["1 900 kr"] },
  { message: "Hva koster trafikalt grunnkurs?", includes: ["3 950 kr", "TABS"] },
  { message: "Hva koster TG?", includes: ["3 950 kr", "TABS"] },
  { message: "Hva koster TGK uten mørkekjøring?", includes: ["ikke tydelig publisert", "3 950 kr"], unsure: true },
  { message: "Hva koster trafikalt grunnkurs med mørkekjøring?", includes: ["3 950 kr"] },
  { message: "Hva koster en MC-kjøretime?", includes: ["1 160 kr"] },
  { message: "Hva koster en kjøretime for A1?", includes: ["1 160 kr"] },
  { message: "Hva koster trinnvurdering trinn 2 for MC?", includes: ["1 160 kr"] },
  { message: "Hva koster trinnvurdering trinn 3 for MC?", includes: ["1 540 kr"] },
  { message: "Hva koster MC-grunnkurset?", includes: ["1 400 kr"] },
  { message: "Hva koster grunnkurs A1?", includes: ["1 400 kr"] },
  { message: "Hva koster obligatorisk MC-kurs A2?", includes: ["1 400 kr"] },
  { message: "Hva koster utvidelse fra A1 til A2?", includes: ["ikke tydelig publisert"], unsure: true },
  { message: "Hva koster utvidelse A1-A2?", includes: ["ikke tydelig publisert"], unsure: true },
  { message: "Hva koster utvidelse fra A2 til A?", includes: ["7 500 kr"] },
  { message: "Hva koster overgang A2-A?", includes: ["7 500 kr"] },
  { message: "Hva koster BAut?", includes: ["ikke én samlet pris", "TABS"] },
  { message: "Hva koster B?", includes: ["ikke én samlet pris", "TABS"] },
  { message: "Hva er prisen for klasse A1?", includes: ["ikke én samlet pris", "TABS"], forbids: ["125 ccm"] },
  { message: "Hva er trafikalt grunnkurs?", includes: ["første trinn", "Statens vegvesen"] },
  { message: "Hva er TG?", includes: ["første trinn", "Statens vegvesen"] },
  { message: "Må jeg ta TG?", includes: ["første trinn", "Statens vegvesen"] },
  { message: "Må jeg ta TGK når jeg er over 25?", includes: ["fritatt", "førstehjelp", "Trafikant i mørket"] },
  { message: "Jeg er over 25, hva koster mørkekjøring?", includes: ["1 900 kr"], forbids: ["fritatt"] },
  { message: "Jeg er over 25, hva koster førstehjelp?", includes: ["875 kr"], forbids: ["fritatt"] },
  { message: "Hva er forskjellen på automat og manuell?", includes: ["kode 78", "førerprøve"] },
  { message: "Hva er forskjellen på B og BAut?", includes: ["kode 78", "manuelt gir"] },
  { message: "Hvor mange kjøretimer trenger jeg?", includes: ["individuelt", "fast antall"] },
  { message: "Er prisene alltid de samme?", includes: ["TABS", "kan endres"] },
  { message: "Hvor finner jeg den oppdaterte prislisten?", includes: ["TABS", "pris"] },
  { message: "Hva er totalprisen for førerkortet?", includes: ["totalprisen", "varierer"] },

  // Courses, people and the published contact flow.
  { message: "Når er neste trafikale grunnkurs?", includes: ["kursoversikt"] },
  { message: "Når er neste TG?", includes: ["kursoversikt"] },
  { message: "Neste MC-grunnkurs?", includes: ["kursoversikt"] },
  { message: "Når er neste mørkekjøring?", includes: ["kursoversikt"] },
  { message: "TGK i morgen?", includes: ["kursoversikt"] },
  { message: "TGK neste uke?", includes: ["kursoversikt"] },
  { message: "Er det kurs 9. september?", includes: ["kursoversikt"] },
  { message: "Er det kurs 16.03.2026?", includes: ["kursoversikt"], forbids: ["personopplysninger"] },
  { message: "Når starter kurset 01.09.2026?", includes: ["kursoversikt"], forbids: ["personopplysninger"] },
  { message: "Har dere Hvaler TGK?", includes: ["Hvaler TGK", "kursoversikt"] },
  { message: "Er det ledige plasser på neste kurs?", includes: ["kursoversikt"] },
  { message: "Hvordan melder jeg meg på kurs?", includes: ["kursoversikt"] },
  { message: "Hvordan bestiller jeg opplæring?", includes: ["TABS", "kontakt"] },
  { message: "Hvordan booker jeg time?", includes: ["forespørsel", "TABS"] },
  { message: "Hvor bestiller jeg?", includes: ["forespørsel", "TABS"] },
  { message: "Send link til prisene", includes: ["https://onsoytrafikkskole.tabs.no/"] },
  { message: "Lenke til kursene", includes: ["https://onsoytrafikkskole.tabs.no/kursoversikt"] },
  { message: "Link til booking", includes: ["forespørsel", "https://onsoytrafikkskole.tabs.no/"] },
  { message: "Hvor logger eksisterende elever inn?", includes: ["TABS", "https://tabs.no/start"] },
  { message: "Hvem jobber hos dere?", includes: ["Einar", "Mari", "Renate"] },
  { message: "Hvem er Einar Lie?", includes: ["Einar", "trafikklærer"] },
  { message: "Hvem er Mari Thøgersen?", includes: ["Mari", "trafikklærer"] },
  { message: "Hvem er Renate Tomasli?", includes: ["Renate", "kontoransvarlig"] },
  { message: "Hvem er Marianne?", includes: ["finner ikke et sikkert svar"], forbids: ["Mari Fernanda"], unsure: true },

  // Natural first and last turns should also feel complete.
  { message: "Hva kan du hjelpe meg med?", includes: ["førerkortklasser", "priser", "kurs"] },
  { message: "Hva kan jeg spørre om?", includes: ["førerkortklasser", "kontaktinformasjon"] },
  { message: "Fortell om skolen", includes: ["Freskoveien 16", "FMV", "A1"] },
  { message: "Takk!", includes: ["Bare hyggelig"] },
  { message: "Supert, takk", includes: ["Bare hyggelig"] },
  { message: "Ha det", includes: ["Ha det bra"] },

  // The demo must not pretend to capture leads or know unpublished policies.
  { message: "Kan dere ringe meg tilbake?", includes: ["kan ikke", "lagre"] },
  { message: "Kan du lagre kontaktinformasjonen min?", includes: ["kan ikke", "lagre"] },
  { message: "Kan jeg fylle inn eposten min her?", includes: ["kan ikke", "lagre"] },
  { message: "Kan chatten sende henvendelsen min til skolen?", includes: ["kan ikke", "videresende"] },
  { message: "Kan du videresende meldingen min?", includes: ["kan ikke", "videresende"] },
  { message: "Lagrer dere IP-adressen min?", includes: ["nettverksadresse", "midlertidig"], forbids: ["Freskoveien"] },
  { message: "Hvordan behandles dataene mine?", includes: ["bruksloggen", "personopplysninger"] },
  { message: "Min adresse er Testveien 1", includes: ["kan ikke", "personopplysninger"], forbids: ["Testveien 1", "Freskoveien"] },
  { message: "Jeg heter Ola og e-posten min er ola@example.com", includes: ["kan ikke", "lagre"], forbids: ["ola@example.com"] },
  { message: "Telefonnummeret mitt er 91234567", includes: ["kan ikke", "lagre"], forbids: ["91234567"] },
  { message: "Fødselsnummeret mitt er 01010112345", includes: ["kan ikke", "lagre"], forbids: ["01010112345"] },
  { message: "Send svaret til test@example.com", includes: ["kan ikke", "lagre"], forbids: ["test@example.com"] },
  { message: "Kan du booke en kjøretime for meg?", includes: ["TABS", "kontakt"] },
  { message: "Hva er avbestillingsfristen?", includes: ["ikke tydelig oppgitt", "kontakt"] },
  { message: "Kan jeg betale med Vipps?", includes: ["ikke tydelig oppgitt", "kontakt"] },
  { message: "Tilbyr dere delbetaling?", includes: ["ikke tydelig oppgitt", "kontakt"] },
  { message: "Hvor lenge varer en vanlig kjøretime?", includes: ["finner ikke et sikkert svar"], unsure: true },
  { message: "Henter dere meg på skolen?", includes: ["oppgir ikke", "kontakt"] },
  { message: "Tilbyr dere opplæring på engelsk?", includes: ["finner ikke et sikkert svar"], unsure: true },
  { message: "Hva er adressen til MC-avdelingen?", includes: ["FMV", "ikke publisert"] },
  { message: "Hva koster sikkerhetskurs på vei A2?", includes: ["5 800 kr"] },
  { message: "Hva blir været i Fredrikstad i morgen?", includes: ["finner ikke et sikkert svar"], unsure: true },
  { message: "Selger dere pizza?", includes: ["finner ikke et sikkert svar"], unsure: true },
  { message: "Hvem er statsminister?", includes: ["finner ikke et sikkert svar"], unsure: true }
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
    // Route assertions below will report the status/body mismatch.
  }

  return { response, body };
}

const server = app.listen(0, async () => {
  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const failures = [];

    for (const [index, check] of checks.entries()) {
      const { response, body } = await chat(baseUrl, check.message, {
        ip: `198.51.100.${index + 20}`
      });
      const reply = folded(body.reply);
      const missing = check.includes.filter((expected) => !reply.includes(folded(expected)));
      const forbidden = (check.forbids || []).filter((value) => reply.includes(folded(value)));
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
    assert.equal(routeConfig.name, "Onsøy Trafikkskole");

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

    const rejected = await chat(baseUrl, "Hei", {
      origin: "https://not-allowed.example",
      ip: "203.0.113.20"
    });
    assert.equal(rejected.response.status, 403);
    assert.equal(rejected.body.unsure, true);

    const unknown = await chat(baseUrl, "Hei", {
      client: "unknown-school",
      ip: "203.0.113.30"
    });
    assert.equal(unknown.response.status, 400);
    assert.equal(unknown.body.unsure, true);

    const empty = await chat(baseUrl, "   ", { ip: "203.0.113.40" });
    assert.equal(empty.response.status, 400);
    assert.equal(empty.body.unsure, true);

    console.log(`✅ Onsøy passed ${checks.length} answer checks, route/CORS checks and ${kb.length} KB entries.`);
  } finally {
    server.close();
  }
});
