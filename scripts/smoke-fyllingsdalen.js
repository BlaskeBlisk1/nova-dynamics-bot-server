const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { app, publicDemoConfig } = require("../index");

const kbPath = path.join(process.cwd(), "clients", "fyllingsdalen", "kb.json");
const kb = JSON.parse(fs.readFileSync(kbPath, "utf8"));
const config = publicDemoConfig("fyllingsdalen");

assert.ok(kb.length >= 95, `Expected at least 95 Fyllingsdalen entries, found ${kb.length}.`);
assert.equal(config.name, "Fyllingsdalen Trafikkskole");
assert.equal(config.theme, "fjord");
assert.equal(config.accent, "#48a9ff");
assert.equal(config.accentSecondary, "#45e0c1");
assert.ok(config.logo.includes("fyllingsdalen-trafikkskole-logo"));
assert.equal(config.assistantInitial, "F");
assert.equal(config.statusLabel, "Klar til å svare");
assert.match(config.sourceTitle, /verifiserte kilder/);
assert.match(config.sourceDescription, /Statens vegvesen/);
assert.equal(config.highlights.length, 3);
assert.equal(config.suggestedQuestions.length, 4);

for (const [index, entry] of kb.entries()) {
  assert.equal(typeof entry.q, "string", `Entry ${index} has no question.`);
  assert.equal(typeof entry.a, "string", `Entry ${index} has no answer.`);
  assert.ok(entry.q.trim().length > 4, `Entry ${index} has a short question.`);
  assert.ok(entry.a.trim().length > 12, `Entry ${index} has a short answer.`);
}

assert.doesNotMatch(
  JSON.stringify(kb).toLowerCase(),
  /samle inn navn|lagre kontakt|fange lead|lead capture/
);

const checks = [
  ["Hva koster en kjøretime for klasse B?", "900 kr"],
  ["Hva koster en kjøretime på automat?", "900 kr"],
  ["Hva koster en A2-kjøretime?", "1 050 kr"],
  ["Hva koster sikkerhetskurs på veg for A1?", "6 000 kr"],
  ["Hva koster oppkjøring for BE?", "2 900 kr"],
  ["Hva er forskjellen på BE og B96?", "3 500 og 4 250 kg"],
  ["Kan dere hente meg i Bergen sentrum?", "Bergen sentrum"],
  ["Henter dere på Sotra?", "Sotra"],
  ["Tilbyr dere opplæring på tegnspråk?", "tegnspråk"],
  ["Hvor holder dere til?", "Folke Bernadottes vei 44"],
  ["Hva er e-postadressen?", "gmail.com"],
  ["Når er kontoret åpent?", "tirsdag kl. 15–16"],
  ["Hvilke klasser tilbyr dere?", "A1 og A2"],
  ["Hvordan melder jeg meg på?", "elevside"],
  ["Hva koster trafikalt grunnkurs?", "1 400 kr"],
  ["Hva koster mørkekjøring?", "1 500 kr"],
  ["Hva koster mørkekjøring, og hvor mange timer tar det?", "1 500 kr"],
  ["Hva koster trafikalt grunnkurs, og hvor mange timer varer det?", "1 400 kr"],
  ["Hva koster en kjøretime på lørdag?", "1 700 kr"],
  ["Hva koster en kjøretime etter klokken 16?", "1 050 kr"],
  ["Hva koster trinnvurdering trinn 3 for klasse B?", "1 265 kr"],
  ["Hva koster en pakke med 16 timer?", "37 000 kr"],
  ["Hva koster lastsikringskurs?", "1 700 kr"],
  ["Hva koster sikkerhetskurs på bane med automat?", "7 150 kr"],
  ["Hva er avbestillingsfristen?", "24 timer"],
  ["Hvor tidlig bør jeg starte før oppkjøringen?", "fem måneder"],
  ["Hvem jobber hos dere?", "Eirik Kråkevik"],
  ["Hva koster kjøretime klasse A?", "1 050 kr"],
  ["Hvor er kursoversikten?", "Kursdatoer"],
  ["Hvor er elevsiden?", "hovedmenyen"],
  ["Kan en døv elev få tilrettelagt opplæring?", "tegnspråk"],
  ["Hva er trafikalt grunnkurs?", "første steg"],
  ["Når er neste trafikalt grunnkurs?", "oppdaterte kursoversikten"],
  ["Hvor er prislisten?", "prisoversikten"],
  ["Hvor mye koster vanlig time for A1?", "1 050 kr"],
  ["Hva er prisen på A2 sikkerhetskurs på vei?", "5 610 kr"],
  ["Hva koster trinn 2 for bil?", "850 kr"],
  ["Hva koster trinn 3 for bil?", "1 265 kr"],
  ["Er vegvesen-gebyret inkludert i oppkjøring?", "ikke inkludert"],
  ["Hvilke førerkortklasser tilbyr dere?", "A1 og A2"],
  ["Hva koster A-kjøretime?", "1 050 kr"],
  ["A2-kjøretime på lørdag?", "ikke en egen lørdagspris"],
  ["Automat-kjøretime på lørdag?", "1 700 kr"],
  ["Hva koster en vanlig automat-kjøretime etter kl 16?", "separat linje på 1 500 kr"],
  ["Har dere kurs på mandag?", "oppdaterte kursoversikten"],
  ["Er dere åpne?", "tirsdag kl. 15–16"],
  ["Hva er aldersgrensen for A1?", "16 år"],
  ["Må jeg ta trafikalt grunnkurs når jeg er over 25?", "fritatt fra selve trafikalt grunnkurs"],
  ["Hva koster oppkjøring?", "2 850 kr for klasse B"],
  ["Hva er mørkekjøring?", "Kursnavn, sted og pris varierer"],
  ["Når er neste mørkekjøring?", "oppdaterte kursoversikten"],
  ["Hva er organisasjonsnummeret?", "ikke oppgitt"],
  ["Hvor lang tid tar sikkerhetskurs på vei?", "360 minutter"],
  ["Hva koster glattkjøring?", "7 150 kr"],
  ["Hva koster øvingsbane med automat?", "5 400 kr for automat"],
  ["Hva koster grunnpakken med 20 kjøretimer?", "41 000 kr"],
  ["Hva koster en kjøretime for A?", "1 050 kr"],
  ["A-klasse kjøretime?", "1 050 kr"],
  ["Pakke med 20 timer klasse B?", "41 000 kr"],
  ["Hva koster sikkerhetskurs på bane?", "7 150 kr"],
  ["Undervisning for hørselshemmede?", "tegnspråk"],
  ["Har dere tegnspråktolk?", "tegnspråk"],
  ["Avlyse kjøretime", "24 timer"],
  ["Hvordan flytter jeg kjøretimen?", "24 timer"],
  ["Hva koster bomringgebyret?", "750 kr"],
  ["Hva må jeg ha før A2?", "ikke fullstendig spesifisert"],
  ["Time klasse B", "900 kr"],
  ["B-time", "900 kr"],
  ["Time klasse A", "1 050 kr"],
  ["Kan jeg ta klasse B når jeg er 16?", "førerprøven er 18 år"],
  ["Kan en 16-åring øvelseskjøre klasse B?", "øvelseskjøre fra du er 16 år"],
  ["Hva er forskjellen på automat og manuell?", "kode 78"],
  ["Kan jeg kjøre manuell etter automatlappen?", "ny førerprøve med manuelt gir"],
  ["Hva kreves for BE?", "minst sju timer"],
  ["Hvilke pakker har dere?", "35 175 kr"],
  ["Hvilke pakker har dere?", "37 775 kr"],
  ["Hvilke pakker har dere?", "41 000 kr"],
  ["Hva koster en 16-timerspakke klasse B?", "35 175 kr"],
  ["Hva koster en 16-timerspakke klasse B?", "37 000 kr"],
  ["Hva koster en 20-timerspakke klasse B?", "37 775 kr"],
  ["Hva koster en 20-timerspakke klasse B?", "41 000 kr"],
  ["Hva koster trinnvurdering?", "Oppgi klasse og trinn"],
  ["Hva koster trinnvurdering trinn 2 for A?", "1 050 kr"],
  ["Hva koster trinnvurdering trinn 3 for BE?", "1 275 kr"],
  ["Hva er førerprøve?", "praktiske avsluttende prøven"],
  ["Når er neste mørkekurs?", "oppdaterte kursoversikten"],
  ["Kan jeg booke mørkekurset?", "oppdaterte kursoversikten"],
  ["Hva koster mørkekurs?", "1 500 kr"],
  ["Hva koster mørkekurs?", "2 200 kr"],
  ["Kan hørselshemmede få opplæring?", "tegnspråk"],
  ["Har dere tilrettelegging for tunghørte?", "tegnspråk"],
  ["Hva er åpningstidene på hovednettsiden?", "tirsdag og onsdag kl. 11–12.30"],
  ["Hva er åpningstidene i TABS?", "tirsdag kl. 15–16"],
  ["A time", "1 050 kr"],
  ["Time A2", "1 050 kr"],
  ["A1-time", "1 050 kr"],
  ["Hva er timeprisen?", "Hvilken klasse mener du"],
  ["Er automat billigere enn manuell?", "900 kr"],
  ["Hva kreves for B96?", "ikke ta en ny førerprøve"],
  ["Hva er kravene til hengerlappen?", "B96 eller BE"],
  ["Hvordan bestiller jeg oppkjøring?", "bestilles hos Statens vegvesen"],
  ["Hva blir totalprisen på lappen?", "ikke en garanti for totalprisen"],
  ["Hvilke MC-pakker har dere?", "28 450 kr"],
  ["Jeg bruker høreapparat – kan dere tilrettelegge?", "tegnspråk"],
  ["Hva blir været i Bergen i morgen?", "finner ikke et sikkert svar", true],
  ["Selger dere pizza?", "finner ikke et sikkert svar", true],
  ["Kan jeg ta med hunden min?", "finner ikke et sikkert svar", true],
  ["Hva må jeg ta med på første time?", "finner ikke et sikkert svar", true],
  ["Hvem er statsminister?", "finner ikke et sikkert svar", true],
  ["Hva koster alt til sammen?", "ikke en garanti for totalprisen"],
  ["Hva koster 20 kjøretimer klasse B?", "37 775 kr"],
  ["Hva koster 20 kjøretimer klasse B?", "41 000 kr"],
  ["Hva koster 16 kjøretimer klasse B?", "35 175 kr"],
  ["Hva koster 16 kjøretimer klasse B?", "37 000 kr"],
  ["Hvor lenge varer en kjøretime?", "45 minutter"],
  ["Når er første ledige kjøretime?", "elevsiden"],
  ["Hvor lang tid tar førerkortet?", "fem måneder"],
  ["Hva inngår i obligatorisk opplæring?", "sikkerhetskurs på øvingsbane"],
  ["Hvor gammel for A?", "24 år"],
  ["Jeg er 20 og har hatt A2 i to år. Kan jeg ta klasse A?", "minst to år"],
  ["Jeg er 22 og har ikke A2. Kan jeg ta A?", "ikke før du er 24 år"],
  ["Kan jeg ta klasse A før 24 uten å ha A2?", "ikke før du er 24 år"],
  ["Hva koster sikkerhetskurs på vei A?", "6 800 kr"],
  ["Hva koster sikkerhetskurs på vei tung MC?", "6 800 kr"],
  ["Hva koster sikkerhetskurs på vei A-klasse?", "6 800 kr"],
  ["Hva koster sikkerhetskurs på vei lett MC?", "6 000 kr"],
  ["Hva koster sikkerhetskurs på vei mellomtung MC?", "5 610 kr"],
  ["Hva koster sikkerhetskurs på vei mellomtung MC?", "6 200 kr"],
  ["Pris presis kjøreteknikk klasse A?", "5 800 kr"],
  ["Trenger B96 oppkjøring?", "uten en ny førerprøve"],
  ["Er det oppkjøring på B96?", "uten en ny førerprøve"],
  ["Har B96 oppkjøring?", "uten en ny førerprøve"],
  ["Må BE ha oppkjøring?", "BE krever førerprøve"],
  ["Trenger BE førerprøve?", "BE krever førerprøve"],
  ["Hva koster førerprøve for B96?", "ingen oppkjøringspris"],
  ["Hva koster 20 timer A?", "ikke en egen 20-timerspakke"],
  ["Hva koster 10 kjøretimer A?", "28 450 kr"],
  ["Hva koster ti kjøretimer klasse A?", "28 450 kr"],
  ["Hva koster 20 kjøretimer A2?", "ikke en egen 20-timerspakke"],
  ["Hva koster 16 kjøretimer A1?", "ikke en egen 16-timerspakke"],
  ["Kan jeg ta A når jeg er 24?", "24 år"],
  ["Jeg er 24 år, kan jeg ta A direkte?", "24 år"],
  ["A aldersgrense?", "24 år"],
  ["Jeg har hatt A2 i ett år. Kan jeg ta A?", "ett år med A2 er ikke nok"],
  ["Hvor gammel må jeg være for B96?", "18 år"],
  ["Jeg er eldre enn 25. Må jeg ta TGK?", "fritatt fra selve trafikalt grunnkurs"],
  ["Hvordan bestiller jeg en kjøretime?", "elevsiden"],
  ["Hvordan melder jeg meg på TGK?", "oppdaterte kursoversikten"],
  ["Hva koster trafikalt grunnkurs på mandag?", "1 400 kr"],
  ["Hva koster mørkekurs på mandag?", "1 500 kr"],
  ["Hva trenger jeg til første kjøretime?", "ikke en fullstendig huskeliste"],
  ["Hva inngår i obligatorisk opplæring for BE?", "minst sju timer"],
  ["Koster tegnspråkopplæring ekstra?", "tilleggspris er ikke publisert"],
  ["Er 920 12 800 skolens telefonnummer?", "920 12 800"],
  ["Er dintrafikkskole@gmail.com riktig e-post?", "gmail.com"],
  ["Send meg lenken til prislisten", "prisoversikten"],
  ["Kan dere kontakte meg?", "kan ikke lagre"],
  ["Hva koster MC-grunnkurset?", "1 200 kr"],
  ["Hvor mange timer er minimum for BE?", "minst sju timer"],
  ["Hvor mange timer er minimum for B96?", "minst sju timer"],
  ["Hva koster landeveiskjøring for BE?", "3 200 kr"],
  ["Hvem er daglig leder?", "Eirik Kråkevik"],
  ["Hvem er faglig leder?", "John-Magne Øyulvstad"],
  ["Hvilke lærere jobber der?", "Eirik Kråkevik"],
  ["Hva koster en biltime?", "900 kr"],
  ["Hva koster automatkjøring?", "900 kr"],
  ["Hva koster en time med manuell?", "900 kr"],
  ["Hva koster sikkerhetskurs på vei for MC?", "6 800 kr for A"],
  ["Hva koster sikkerhetskurs på veg for motorsykkel?", "6 000 kr for A1"],
  ["Hva koster sikkerhetskurs på bane for MC?", "5 800 kr for A og A2"],
  ["Hvor lenge varer sikkerhetskurs på vei for MC?", "varierer mellom MC-klassene"],
  ["Hvordan bestiller jeg oppkjøring for BE?", "bestilles hos Statens vegvesen"],
  ["Når er første ledige oppkjøring for BE?", "ledige tider"],
  ["Kan jeg flytte oppkjøringen for BE?", "bestilles hos Statens vegvesen"],
  ["Jeg er 24 og har ikke A2. Kan jeg ta klasse A?", "ta klasse A direkte"],
  ["Jeg er 25 år og har aldri hatt A2. Kan jeg ta A?", "ta klasse A direkte"],
  ["Jeg er 22 uten mellomtung MC. Kan jeg ta tung MC?", "ikke før du er 24 år"],
  ["Jeg er 22 og har aldri hatt mellomtung motorsykkel. Kan jeg ta klasse A?", "ikke før du er 24 år"],
  ["Jeg er 22 uten mellomtung MC. Kan jeg få tung MC?", "ikke før du er 24 år"],
  ["Jeg er 22 uten mellomtung MC. Kan jeg kjøre tung MC?", "ikke før du er 24 år"],
  ["Jeg er 22 uten mellomtung MC. Kan jeg oppgradere til tung MC?", "ikke før du er 24 år"],
  ["Jeg er 22 uten mellomtung MC. Kan jeg gå opp til tung MC?", "ikke før du er 24 år"],
  ["Jeg er 23 og har hatt mellomtung MC i tre år. Kan jeg få tung MC?", "kan utvide til klasse A"],
  ["Kan jeg ta B96 uten oppkjøring?", "uten en ny førerprøve"],
  ["Kan jeg ta BE uten oppkjøring?", "BE krever førerprøve"],
  ["Kan jeg kjøre automat med manuelt førerkort?", "Ja."],
  ["Kanseller kjøretimen", "24 timer"],
  ["Henter dere i Fyllingsdalen?", "Fyllingsdalen"],
  ["Henter dere elever hjemme i Fyllingsdalen?", "Fyllingsdalen"],
  ["Kan jeg øvelseskjøre privat?", "minst 25 år"],
  ["Kan jeg velge kvinnelig lærer?", "ønsket lærer"],
  ["Har dere parkering?", "finner ikke et sikkert svar", true],
  ["Har dere intensivkurs?", "finner ikke et sikkert svar", true],
  ["Har dere studentrabatt?", "finner ikke et sikkert svar", true],
  ["Jeg heter Ola og e-posten min er ola@example.com", "kan ikke lagre"],
  ["Mitt telefonnummer er 91234567. Hva koster en kjøretime?", "kan ikke lagre"],
  ["Send svaret til ola@example.com. Hva koster en kjøretime?", "kan ikke lagre"],
  ["Navn: Ola Nordmann. E-post: ola@example.com", "kan ikke lagre"],
  ["Fødselsnummeret mitt er 01010112345", "kan ikke lagre"],
  ["Kan du lagre kontaktinformasjonen min?", "kan ikke lagre"],
  ["Må jeg ta trafikalt grunnkurs når jeg er over 25?", "fritatt fra selve trafikalt grunnkurs"],
  ["Jeg er 26, må jeg ta mørkekjøring?", "må fortsatt gjennomføre Trafikant i mørket"],
  ["Jeg er 26, må jeg ta førstehjelp?", "Plikter ved trafikkuhell og førstehjelp"],
  ["Kan en 25-åring være ledsager?", "hatt førerkort i samme klasse sammenhengende i minst fem år"],
  ["Jeg er 17 og har A1. Kan jeg ta A2?", "førerprøven i klasse A2 er 18 år"],
  ["Kan jeg øvelseskjøre A1 når jeg er 15?", "øvelseskjøre fra du er 15 år"],
  ["Kan jeg øvelseskjøre A2 når jeg er 16?", "øvelseskjøre fra du er 16 år"],
  ["Kan jeg øvelseskjøre klasse A når jeg er 22?", "øvelseskjøre fra du er 22 år"],
  ["Jeg er 20 og har A2. Kan jeg øvelseskjøre klasse A?", "kan du øvelseskjøre med klasse A før du er 22 år"],
  ["Kan jeg øvelseskjøre klasse A før jeg er 22 hvis jeg har A2?", "kan du øvelseskjøre med klasse A før du er 22 år"],
  ["Jeg er 21 og har ikke A2. Kan jeg øvelseskjøre tung MC?", "Uten A2 kan du øvelseskjøre med klasse A fra du er 22 år"],
  ["Jeg er 19 og har hatt A2 i to år. Kan jeg ta klasse A?", "20 år til tidligste mulige alder"],
  ["Kan jeg avbestille mørkekjøringskurset 24 timer før?", "Avbestillingsfristen for kurs er ikke bekreftet"],
  ["Kan jeg avbestille mørkedemo 24 timer før?", "Avbestillingsfristen for kurs er ikke bekreftet"],
  ["Kan jeg avbestille Trafikant i mørket 24 timer før?", "Avbestillingsfristen for kurs er ikke bekreftet"],
  ["Kan jeg avbestille TGK 24 timer før?", "Avbestillingsfristen for kurs er ikke bekreftet"],
  ["Kan jeg avbestille oppkjøringen 24 timer før?", "endres og avbestilles hos Statens vegvesen"],
  ["Kan du ringe meg tilbake?", "kan ikke lagre"],
  ["Jobber Sindre fortsatt?", "hovednettsiden viser en annen ansattliste"]
];

const server = app.listen(0, async () => {
  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const failures = [];

    for (const [index, [message, expected, expectedUnsure]] of checks.entries()) {
      const response = await fetch(`${baseUrl}/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Origin": "https://nova-dynamics-bot-server.onrender.com",
          "X-Forwarded-For": `198.51.100.${index + 1}`
        },
        body: JSON.stringify({ client: "fyllingsdalen", message })
      });
      const body = await response.json();

      if (
        response.status !== 200 ||
        !String(body.reply || "").includes(expected) ||
        (typeof expectedUnsure === "boolean" && body.unsure !== expectedUnsure)
      ) {
        failures.push(
          `Question \"${message}\" expected status 200, \"${expected}\"${typeof expectedUnsure === "boolean" ? ` and unsure=${expectedUnsure}` : ""}, got status ${response.status}, unsure=${body.unsure}: \"${body.reply}\".`
        );
      }
    }

    assert.deepEqual(failures, [], failures.join("\n"));

    const rejectedIp = "203.0.113.240";

    for (let i = 0; i < 125; i += 1) {
      const rejected = await fetch(`${baseUrl}/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Origin": "https://not-allowed.example",
          "X-Forwarded-For": rejectedIp
        },
        body: JSON.stringify({ client: "fyllingsdalen", message: "Hei" })
      });

      assert.equal(rejected.status, 403);
    }

    const validAfterRejected = await fetch(`${baseUrl}/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Origin": "https://nova-dynamics-bot-server.onrender.com",
        "X-Forwarded-For": rejectedIp
      },
      body: JSON.stringify({ client: "fyllingsdalen", message: "Hvor holder dere til?" })
    });

    assert.equal(validAfterRejected.status, 200);

    const emptyResponse = await fetch(`${baseUrl}/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Origin": "https://nova-dynamics-bot-server.onrender.com"
      },
      body: JSON.stringify({ client: "fyllingsdalen", message: "   " })
    });

    assert.equal(emptyResponse.status, 400);

    console.log(`✅ Fyllingsdalen passed ${checks.length} answer checks across ${kb.length} entries.`);
  } finally {
    server.close();
  }
});
