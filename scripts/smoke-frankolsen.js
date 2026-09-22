const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { app, publicDemoConfig } = require("../index");

const CLIENT = "frankolsen";
const RENDER_ORIGIN = "https://nova-dynamics-bot-server.onrender.com";
const BUSINESS_ORIGIN = "https://www.frankolsen.no";
const kbPath = path.join(process.cwd(), "clients", CLIENT, "kb.json");
const cssPath = path.join(process.cwd(), "public", "demo", "styles.css");
const demoAppPath = path.join(process.cwd(), "public", "demo", "app.js");
const kb = JSON.parse(fs.readFileSync(kbPath, "utf8"));
const css = fs.readFileSync(cssPath, "utf8");
const demoApp = fs.readFileSync(demoAppPath, "utf8");
const config = publicDemoConfig(CLIENT);

assert.ok(kb.length >= 60, `Expected at least 60 Frank Olsen entries, found ${kb.length}.`);
assert.equal(config.client, CLIENT);
assert.equal(config.name, "Frank Olsen Brilleoptikk");
assert.match(config.website, /^https:\/\/www\.frankolsen\.no\/?$/);
assert.equal(config.assistantInitial, "FO");
assert.equal(config.assistantLabel, "Synsassistent");
assert.equal(config.theme, "optical");
assert.equal(config.accent.toLowerCase(), "#f1b401");
assert.ok(config.highlights.length === 3);
assert.ok(config.suggestedQuestions.length >= 6);
assert.match(config.sourceDescription, /offisielle nettsiden/i);
assert.match(css, /body\[data-theme="optical"\]/);
assert.match(css, /Lens rings|Lens|lens rings/i);
assert.match(demoApp, /function appendLinkedText/);
assert.match(demoApp, /link\.target = "_blank"/);

for (const [index, entry] of kb.entries()) {
  assert.equal(typeof entry.q, "string", `Entry ${index} has no question.`);
  assert.equal(typeof entry.a, "string", `Entry ${index} has no answer.`);
  assert.ok(entry.q.trim().length > 2, `Entry ${index} has a short question.`);
  assert.ok(entry.a.trim().length > 12, `Entry ${index} has a short answer.`);
}

const serializedDemo = JSON.stringify({ kb, config }).toLowerCase();
assert.doesNotMatch(serializedDemo, /samler inn navn|lagrer kontakt(?:data|informasjon)|fanger leads?|bestiller timen for deg/);
assert.doesNotMatch(serializedDemo, /garantert på lager|garanterer diagnose|stiller diagnose/);
assert.doesNotMatch(serializedDemo, /50% (?:rabatt|avslag)|5[ .]?190 kr/);
assert.doesNotMatch(serializedDemo, /\bAI\b/i);

const checks = [
  // Identity and contact.
  { message: "Hvor holder dere til?", includes: ["Kong Oscars gate 22", "5017 Bergen"] },
  { message: "Ka e adressa?", includes: ["Kong Oscars gate 22"] },
  { message: "Kvar finn eg butikken?", includes: ["Kong Oscars gate 22", "5017 Bergen"] },
  { message: "Ligger dere i Bergen?", includes: ["Kong Oscars gate 22", "Bergen"] },
  { message: "Hvor ligger legevakten?", includes: ["ikke en verifisert adresse", "offisiell helsetjeneste", "113"], forbids: ["Kong Oscars gate 22"], unsure: true },
  { message: "Hva er adressen til legevakten?", includes: ["ikke en verifisert adresse", "offisiell helsetjeneste"], forbids: ["Kong Oscars gate 22"], unsure: true },
  { message: "Hva er telefonnummeret til legevakten?", includes: ["ikke en verifisert", "offisiell helsetjeneste"], forbids: ["922 26 784"], unsure: true },
  { message: "Hvor holder øyelegen til?", includes: ["ikke verifisert kontaktinformasjon", "henviser videre"], forbids: ["Kong Oscars gate 22"], unsure: true },
  { message: "Hvor ligger nærmeste parkering?", includes: ["ikke spesifisert", "Parkering"], forbids: ["Kong Oscars gate 22"], unsure: true },
  { message: "Hva er telefonnummeret?", includes: ["922 26 784"] },
  { message: "Kan jeg sende SMS?", includes: ["922 26 784", "sier ikke", "SMS"], unsure: true },
  { message: "Hva er e-posten deres?", includes: ["post@frankolsen.no"] },
  { message: "Hvordan kontakter jeg dere?", includes: ["922 26 784", "post@frankolsen.no", "/kontakt"] },
  { message: "Hva er nettsiden deres?", includes: ["https://www.frankolsen.no/"] },

  // Opening hours and unknown exceptions.
  { message: "Når har dere åpent?", includes: ["mandag–onsdag", "09.30–16.00", "torsdag", "09.30–18.00", "lørdag", "10.00–14.30"] },
  { message: "Når åpner dere mandag?", includes: ["Mandag", "09.30–16.00"] },
  { message: "Åpent på tirsdag?", includes: ["Tirsdag", "09.30–16.00"] },
  { message: "Når stenger dere onsdag?", includes: ["Onsdag", "09.30–16.00"] },
  { message: "Når har dere åpent på torsdag?", includes: ["Torsdag", "09.30–18.00"] },
  { message: "Åpent fredag?", includes: ["Fredag", "09.30–16.00"] },
  { message: "Er dere åpne lørdag?", includes: ["Lørdag", "10.00–14.30"] },
  { message: "Har dere åpent søndag?", includes: ["ingen åpningstid", "søndag", "922 26 784"], unsure: true },
  { message: "Hva er åpningstidene i julen?", includes: ["ikke spesifisert", "helligdager"], unsure: true },
  { message: "Har dere åpent 17. mai?", includes: ["ikke spesifisert", "helligdager"], unsure: true },

  // Booking and free eye examination.
  { message: "Hvordan bestiller jeg time?", includes: ["https://www.frankolsen.no/kontakt", "timeboken", "gjennomfører ikke"] },
  { message: "Trenger jeg timeavtale?", includes: ["https://www.frankolsen.no/kontakt", "timeboken", "gjennomfører ikke"] },
  { message: "Har dere ledige timer?", includes: ["https://www.frankolsen.no/kontakt", "timeboken", "gjennomfører ikke"] },
  { message: "Korleis får eg time?", includes: ["https://www.frankolsen.no/kontakt", "timeboken", "gjennomfører ikke"] },
  { message: "Kan jeg bestille synstest på nett?", includes: ["/kontakt", "Bestill", "ikke"] },
  { message: "Bestill en time for meg i morgen", includes: ["kan ikke bestille", "/kontakt"] },
  { message: "Kan jeg bestille time for nye briller?", includes: ["/kontakt", "timeboken", "gjennomfører ikke"], forbids: ["ønsket innfatning"] },
  { message: "Hvordan bestiller jeg time for å få briller?", includes: ["/kontakt", "timeboken", "gjennomfører ikke"], forbids: ["ønsket innfatning"] },
  { message: "Kan dere bestille Ray-Ban til meg?", includes: ["kan bestille", "innfatning", "leveringstid"], forbids: ["timeboken"] },
  { message: "Kan dere bestille en Prada-innfatning?", includes: ["kan bestille", "innfatning", "leveringstid"], forbids: ["timeboken"] },
  { message: "Kan dere bestille den brillen?", includes: ["kan bestille", "innfatning", "leveringstid"], forbids: ["timeboken"] },
  { message: "Kan dere bestille en modell dere ikke har?", includes: ["kan bestille", "innfatning", "leveringstid"], forbids: ["timeboken"] },
  { message: "Hva koster en synsundersøkelse?", includes: ["gratis", "/kontakt"] },
  { message: "Kva kostar synssjekk?", includes: ["gratis", "/kontakt"] },
  { message: "Kan eg få sjekka augene?", includes: ["gratis", "fundusfoto", "trykkmåling"] },
  { message: "Er synstesten gratis?", includes: ["gratis", "fundusfoto", "trykkmåling"] },
  { message: "Hva inngår i synsundersøkelsen?", includes: ["syns- og øyehelseundersøkelse", "fundusbilde", "trykkmåling"] },
  { message: "Undersøker dere øyehelsen?", includes: ["øyehelse", "fundusbilde", "trykkmåling"] },
  { message: "Hvor lang tid tar synsundersøkelsen?", includes: ["ikke spesifisert", "Varighet"], unsure: true },

  // Eye-health equipment and appropriate limits.
  { message: "Tar dere bilde av netthinnen?", includes: ["fundusbilde", "innsiden av øyet", "alle kunder"] },
  { message: "Lagrer dere fundusbildet?", includes: ["fundusbilder lagres", "senere konsultasjoner", "personvern"] },
  { message: "Måler dere trykket i øyet?", includes: ["Trykkmåling", "én av flere", "diagnose"] },
  { message: "Henviser dere til øyelege?", includes: ["henvises", "øyelege", "medisinsk oppfølging"] },
  { message: "Oppdager dere grønn stær?", includes: ["mistanke", "øyelege", "kan ikke", "diagnose"] },
  { message: "Har jeg grønn stær?", includes: ["kan ikke", "stille diagnose", "faglig undersøkelse"], unsure: true },
  { message: "Jeg tror jeg har grønn stær, kan du bestille time?", includes: ["kan ikke", "stille diagnose", "faglig undersøkelse"], forbids: ["timeboken"], unsure: true },
  { message: "Hvilken brillestyrke trenger jeg?", includes: ["kan ikke", "anbefale styrke", "faglig undersøkelse"], unsure: true },
  { message: "Jeg fikk plutselig synstap og sterke øyesmerter", includes: ["kan ikke vurdere", "akutt helsehjelp", "med en gang"], unsure: true },
  { message: "Jeg har plutselig mistet synet, kan du bestille time for meg?", includes: ["kan ikke vurdere", "akutt helsehjelp", "med en gang"], forbids: ["timeboken"], unsure: true },
  { message: "Ring meg på 98765432, jeg har plutselig synstap", includes: ["kan ikke vurdere", "akutt helsehjelp", "med en gang"], forbids: ["98765432"], unsure: true },
  { message: "Kan du sende e-post til butikken, jeg har sterke øyesmerter", includes: ["kan ikke vurdere", "akutt helsehjelp", "med en gang"], forbids: ["post@frankolsen.no"], unsure: true },

  // Contact lenses.
  { message: "Tilbyr dere kontaktlinser?", includes: ["kontaktlinsetilpasning", "individuell undersøkelse"] },
  { message: "Hvordan tilpasses kontaktlinser?", includes: ["hornhinnens krumming", "mikroskop", "egnet løsning"] },
  { message: "Kan jeg bruke kontaktlinser med skjeve hornhinner?", includes: ["skjeve hornhinner", "individuell undersøkelse"] },
  { message: "Finnes det linser for progressive briller?", includes: ["progressive briller", "individuell"] },
  { message: "Kan jeg bruke linser bare av og til?", includes: ["sporadisk", "regelmessig"] },
  { message: "Kan jeg sove med kontaktlinser?", includes: ["over natten", "aldri", "optiker", "godkjent"] },
  { message: "Hvilke kontaktlinseleverandører bruker dere?", includes: ["Alcon", "Bausch & Lomb", "CooperVision", "Johnson & Johnson"] },
  { message: "Hva koster kontaktlinser?", includes: ["ikke spesifisert", "generell pris", "linsetype"], unsure: true },

  // Glasses, brands and repair.
  { message: "Hvilke brilleglass bruker dere?", includes: ["Essilor", "Carl Zeiss", "Rodenstock"] },
  { message: "Hvilke brillemerker har dere?", includes: ["Ray-Ban", "Oakley", "Prada", "lagerstatus"] },
  { message: "Har dere Ray-Ban?", includes: ["Ray-Ban", "modell", "lagerstatus"] },
  { message: "Hva koster Ray-Ban?", includes: ["ikke spesifisert", "oppdatert pris", "lagerstatus"], unsure: true },
  { message: "Har dere Oakley på lager?", includes: ["kan ikke bekreftes", "modell", "lagerstatus"], unsure: true },
  { message: "Gjelder Oakley Vanguard Meta-kampanjeprisen fortsatt?", includes: ["eldre", "6. juni", "ikke bekrefte", "lagerstatus"], unsure: true },
  { message: "Kan dere bestille en innfatning dere ikke har?", includes: ["kan bestille", "innfatning", "leveringstid"] },
  { message: "Er denne modellen på lager?", includes: ["ikke spesifisert", "Lagerstatus"], unsure: true },
  { message: "Reparerer dere briller?", includes: ["Reparasjoner", "tilpasning", "tidsbruk"] },
  { message: "Hva koster en brillereparasjon?", includes: ["ikke spesifisert", "Pris på reparasjoner"], unsure: true },
  { message: "Hva koster synsundersøkelse for førerkortattest?", includes: ["ikke bekreftet", "synsattest"], forbids: ["gratis"], unsure: true },
  { message: "Hvordan bestiller jeg en synsattest?", includes: ["ikke bekreftet", "avklare"], forbids: ["gratis", "Velg «Bestill»"], unsure: true },
  { message: "Hvor lenge varer kontaktlinsetilpasning?", includes: ["Varighet", "ikke publisert"], forbids: ["70 år"], unsure: true },
  { message: "Hva koster komplette briller?", includes: ["ikke spesifisert", "generell", "innfatning", "glass"], unsure: true },
  { message: "Selger dere solbriller?", includes: ["briller og solbriller", "lagerstatus"] },

  // Computer glasses and student offer.
  { message: "Tilbyr dere databriller?", includes: ["arbeid ved skjerm", "synsundersøkelse"] },
  { message: "Hva er Eyezen?", includes: ["Eyezen", "datamaskin", "mobil", "optikeren"] },
  { message: "Betaler arbeidsgiveren min for databriller?", includes: ["ikke et komplett", "arbeidsgiver", "offentlige regler"], unsure: true },
  { message: "Hva koster databriller?", includes: ["ikke spesifisert", "Pris på databriller"], unsure: true },
  { message: "Har dere studentrabatt?", includes: ["studenter", "ikke", "fast prosentsats", "dagens betingelser"], unsure: true },
  { message: "Har dere 50 prosent rabatt nå?", includes: ["kan endres", "eldre kampanjer", "bekreftet"], unsure: true },

  // History, practical unknowns and conversation.
  { message: "Hvem er Frank Olsen Brilleoptikk?", includes: ["frittstående", "over 70 år", "Bergen"] },
  { message: "Er optikerne offentlig godkjent?", includes: ["offentlig godkjent"] },
  { message: "Har dere parkering?", includes: ["ikke spesifisert", "Parkering", "Kong Oscars gate 22"], unsure: true },
  { message: "Er det trinnfri inngang?", includes: ["ikke spesifisert", "Tilgjengelighet", "tilrettelegging"], unsure: true },
  { message: "Tar dere synstest av barn?", includes: ["ikke spesifisert", "aldersgrenser", "barnets alder"], unsure: true },
  { message: "Hva kan du hjelpe med?", includes: ["synsundersøkelse", "kontaktlinser", "databriller", "timebestilling"] },
  { message: "Hei!", includes: ["Hei", "synsundersøkelse", "kontaktlinser"] },
  { message: "Takk for hjelpen!", includes: ["Bare hyggelig"] },

  // Action and privacy guardrails.
  { message: "Kan du sende e-post til butikken?", includes: ["kan ikke sende e-post", "post@frankolsen.no"] },
  { message: "Kan dere ringe meg tilbake?", includes: ["kan ikke lagre", "personopplysninger", "/kontakt"] },
  { message: "Jeg heter Ola og e-posten min er ola@example.com", includes: ["kan ikke lagre", "personopplysninger"], forbids: ["ola@example.com"] },
  { message: "Ring meg på 98765432", includes: ["kan ikke lagre", "personopplysninger"], forbids: ["98765432"] },
  { message: "Hvordan lagres chatten?", includes: ["lagrer ikke selve spørsmålet", "nettverksadresse"] },

  // Safe fallback and client isolation.
  { message: "Selger dere pizza?", includes: ["ikke et sikkert svar", "922 26 784"], unsure: true },
  { message: "Tilbyr dere kjøretimer?", includes: ["ikke et sikkert svar", "Frank Olsen"], forbids: ["Trafikk1", "Tiller", "Onsøy", "Fyllingsdalen"], unsure: true },
  { message: "Ligger dere i Industriveien?", includes: ["publiserte adressen", "Kong Oscars gate", "kan ikke bekrefte"], forbids: ["Heimdal"], unsure: true }
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
        ip: `198.51.${Math.floor(index / 240) + 175}.${(index % 240) + 10}`
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
    assert.equal(routeConfig.name, "Frank Olsen Brilleoptikk");
    assert.equal(routeConfig.theme, "optical");

    const officialOrigin = await chat(baseUrl, "Hvor holder dere til?", {
      origin: BUSINESS_ORIGIN,
      ip: "203.0.113.70"
    });
    assert.equal(officialOrigin.response.status, 200);
    assert.equal(officialOrigin.response.headers.get("access-control-allow-origin"), BUSINESS_ORIGIN);

    const preflight = await fetch(`${baseUrl}/chat`, {
      method: "OPTIONS",
      headers: { Origin: BUSINESS_ORIGIN }
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), BUSINESS_ORIGIN);

    const rejectedOrigin = await chat(baseUrl, "Hei", {
      origin: "https://example.invalid",
      ip: "203.0.113.71"
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
      ip: "203.0.113.72"
    });
    assert.equal(unknownClient.response.status, 400);

    for (const debugPath of [
      "/debug-kb?client=frankolsen",
      "/debug-cors",
      "/debug-intent?message=hei",
      "/debug-rank?client=frankolsen&message=synstest"
    ]) {
      const debugResponse = await fetch(`${baseUrl}${debugPath}`);
      assert.equal(debugResponse.status, 404, `${debugPath} must be disabled unless explicitly enabled.`);
      assert.deepEqual(await debugResponse.json(), { error: "Not found." });
    }

    console.log(`Frank Olsen smoke test passed (${checks.length} answer checks, ${kb.length} KB entries).`);
  } catch (error) {
    console.error(error.stack || error);
    process.exitCode = 1;
  } finally {
    server.close();
  }
});
