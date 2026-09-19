"use strict";

// Roma-only, deterministic answer path. No fuzzy retrieval, external model,
// untrusted instructions or another client's knowledge can supply an answer.
const entries = require("./kb.json");
const byId = new Map(entries.map(entry => [entry.id, entry]));
const contact = "Kontakt RoMa på 33 99 40 50 eller post@romatrafikkskole.no.";
const priceSource = "https://romatrafikkskole.no/klasser";
const courseSource = "https://romatrafikkskole.no/kursoversikt";
const contactSource = "https://romatrafikkskole.no/kontakt";
const rulesSource = "https://www.vegvesen.no/forerkort/ta-forerkort/";
const normal = text => String(text || "").normalize("NFKC").toLowerCase()
  .replace(/æ/g, "ae").replace(/ø/g, "o").replace(/å/g, "a")
  .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
  .replace(/[–—]/g, "-").replace(/\s+/g, " ").trim();
const make = (reply, source = contactSource, unsure = false) => ({
  reply: `${reply}\n\n${source}`, unsure, suggestions: []
});
function fact(...ids) {
  const rows = [...new Set(ids)].map(id => byId.get(id)).filter(Boolean);
  return {
    reply: rows.map(row => row.a).join("\n\n") + "\n\n" + [...new Set(rows.map(row => row.source))].join("\n"),
    unsure: rows.some(row => row.unsure === true), suggestions: []
  };
}
function classesIn(t) {
  const classes = [];
  if (/\ba\s*1\b|lett\s*(mc|motorsykkel)/.test(t)) classes.push("A1");
  if (/\ba\s*2\b|mellomtung/.test(t)) classes.push("A2");
  if (/\bklasse a\b(?!\s*[12])|\btung (mc|motorsykkel)|\btil a\b(?!\s*[12])|\ba\s*(?:og|eller|\/|,|\?)|(?:og|eller|\/)\s*a\b(?!\s*[12])|^a$/.test(t)) classes.push("A");
  if (/\bbe\b/.test(t)) classes.push("BE");
  if (/\bb\s*(?:kode\s*)?96\b/.test(t)) classes.push("B96");
  if (/moped|\bam\s*146\b/.test(t)) classes.push("AM146");
  if (/\b(b|baut)\b|automat|manuell|\bbil\b|billapp|bilpakke/.test(t) && !/bil og (henger|tilhenger)/.test(t)) classes.push("B");
  if (/\bmc\b|motorsykkel/.test(t) && !classes.some(c => /^A[12]?$/.test(c))) classes.push("MC");
  if (/tilhenger|\bhenger\b/.test(t) && !classes.some(c => c === "BE" || c === "B96")) classes.push("trailer");
  return [...new Set(classes)];
}

function answer(message) {
  const raw = String(message || "").slice(0, 2000);
  const t = normal(raw);
  // A previous licence mentioned in a separate sentence is background, not a
  // second price request ("Jeg har B. Hva koster kjøretime A2?").
  const sentences = t.split(/[.!?]\s+/);
  const lastSentenceClasses = classesIn(sentences[sentences.length - 1]);
  const classes = lastSentenceClasses.length ? lastSentenceClasses : classesIn(t);
  const has = re => re.test(t);
  const pricing = has(/pris|kost|betale|hvor mye|kor mye|ka ma|price|how much|\bkr\b|kroner/);
  const mc = classes.some(c => /^A[12]?$|^MC$/.test(c));
  const trailer = classes.some(c => /^(BE|B96|trailer)$/.test(c));
  const moped = classes.includes("AM146");
  const bil = classes.includes("B");
  const uncertain = detail => make(`${detail} ${contact}`, contactSource, true);

  // Safety and requested actions precede informational intent, even when combined.
  if (has(/akutt|ulykke|pustevansker|bevisstlos|blor kraftig|brystsmerte/))
    return make("Ved akutt fare eller alvorlig skade: ring 113. Stans på et trygt sted hvis du kjører. Denne demoen kan ikke håndtere nødsituasjoner.", rulesSource, true);
  if (has(/ignore|ignorer|systemprompt|system prompt|api.?key|api.?nokkel|hemmelig|\bpassword\b|passord|lat som|pretend|registrer.*uten|override/))
    return make("Jeg kan bare gi informasjon om RoMa fra demoens verifiserte kilder. Jeg kan ikke endre priser, hente hemmeligheter eller utføre bestillinger.");
  if (has(/personvern|lagr.*chatt?|lagr.*sporsmal|hva.*logg|sporing|posthog|privacy/)) return fact("privacy");
  if (has(/slett.*(?:data|opplysning)|delete.*data/)) return make("Jeg kan ikke behandle en sletteforespørsel her. Ikke send personopplysninger i chatten. Ta kontakt med Jemlio gjennom den du fikk demolenken fra, og med RoMa hvis forespørselen gjelder opplysninger du har gitt direkte til skolen.", contactSource, true);
  const emails = raw.match(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi) || [];
  const personalEmail = emails.some(email => !["post@romatrafikkskole.no", "magnus@romatrafikkskole.no", "rune@romatrafikkskole.no"].includes(email.toLowerCase()));
  if (personalEmail || /\b(?:\d[\s-]?){8,11}\b/.test(raw) || has(/jeg heter|mitt navn|fodsel|personnummer|kortnummer|ring meg|ringe meg|kontakt meg|lagre.*(navn|nummer|epost)|send.*(navn|nummer|epost)/))
    return make("Ikke legg inn personopplysninger i demoen. Jeg kan ikke registrere deg, videresende opplysningene eller avtale at noen ringer deg. Bruk RoMas kontaktskjema eller ring skolen direkte.");
  if (has(/send.*(mail|e-post|epost|melding)|videresend/))
    return make(`Jeg kan ikke sende e-post eller videresende meldinger. ${contact}`);
  if (has(/(?:kan|vil) du.*(book|bestill|reserver|melde|avbestill|endre)|^(?:book|bestill|reserver|meld meg|avbestill)|avbestill.*min time/)) return fact("booking");
  if (has(/avbestill|avmeld|avlys|kanseller|cancell|ikke moter|ikke kan mote|fristen|bestillingsvilkar/)) return fact("cancel");
  if (has(/nar|dato|neste|ledig|ventetid|denne uka|denne uken|i morgen|idag|i dag|september|oktober|november|desember/) && has(/kurs|time|plass|book|starte|oppkjor/) && !has(/nar.*avbestill|etter kl|mork.*sommer|\d+ ar|\b25\b|fritatt|fritak/)) return fact("availability");
  if (has(/apningstid|kontortid|apent|apne|stengt|nar.*kontor|opening hours/)) return fact("hours");
  if (has(/helse|diagnos|epilepsi|adhd|medisin|rus|alkohol|promille|synsattest|synsfeil/))
    return uncertain("Helsekrav og førerrett må vurderes av kvalifisert helsepersonell og Statens vegvesen. Ikke del helseopplysninger her.");
  if (has(/lastebil|\bbuss\b|sn.oscooter|traktor|\bklasse (c|ce|d|de|t)\b/))
    return uncertain("Denne klassen er ikke oppført i RoMas verifiserte tilbud. Skolen oppgir B, BAut, TG, BE, B96, A1, A2, A og AM146.");
  if (has(/hent|parkering|gratis park|rullestol|tegnsprak|intensiv|engelsk|polsk|sprak|english lessons|refusjon|pengene tilbake|rabatt|vipps|klarna|delbetal|avdrag/))
    return uncertain("Dette har jeg ikke bekreftede opplysninger om i RoMas publiserte informasjon. Avtal det direkte med skolen.");
  if (has(/betale|betaling|faktura|forfall/)) return fact("payment");
  if (has(/hvor.*(ligg|holder|finn)|hvor er dere|ligger dere|adresse|adressa|tolvsrod|val loveien|valloveien|location|where are/)) return has(/kontakt|telefon|e-post|epost/) ? fact("address", "contact") : fact("address");
  if (has(/magnus|rune|laerer|ansatt|daglig leder|faglig leder|hvem.*underviser/)) return fact("teachers");
  if (has(/telefon|mobil|e-post|epost|\bmail\b|kontakt|\bsms\b|ringe|phone/)) return fact("contact");
  if (has(/hjemmeside|nettside|website/) && !pricing && !has(/book|bestill|pameld/))
    return make("RoMas offisielle nettside har prisliste, kursoversikt og kontaktinformasjon.", "https://romatrafikkskole.no/");
  if (has(/hva kan du|hvem er du|er du.*(bot|robot)|hva.*demo|hvordan.*demo/)) return fact("limits");
  if (has(/\ba1\b.*(?:til|->|→).*\ba2\b|konverter.*a1|utvid.*a1/)) return fact("convert_a1_a2");
  if (has(/\ba2\b.*(?:til|->|→).*\ba\b|konverter.*a2|utvid.*a2/)) return fact("convert_a2_a");
  if (has(/konverter|utvide|utvidelse/)) return fact("convert_a1_a2", "convert_a2_a");
  if (has(/hvor mange ar|hvor lenge.*hatt/) && classes.includes("A1") && classes.includes("A2")) return fact("convert_a1_a2");
  if (has(/(?:uten|slippe).*?(?:forerprove|oppkjor|bil|klasse b|grunnkurs)|ma jeg.*(?:forerprove|oppkjor)|trenger jeg.*(?:forerprove|oppkjor)/))
    return make("Hvilke kurs og prøver du må gjennomføre, avhenger av klassen og førerretten du allerede har. Jeg kan ikke bekrefte fritak eller personlig førerrett. Be RoMa kontrollere opplegget ditt og se de offisielle kravene hos Statens vegvesen.", rulesSource, true);
  if (has(/hele.*(lappen|forerkort)|totalpris|totalt|hvor mange.*(time|uke)|garanti|garanter|best[aå]tt|billigst|hvilken pakke.*(best|velge)|hva.*trenger.*pakke/)) return fact("total");
  if (has(/teoriprove|offentlig.*gebyr|vegvesen.*gebyr|svv.*gebyr|utstedelse|forerkortproduksjon/))
    return make("Statens vegvesens prøve- og utstedelsesgebyrer kommer ikke automatisk med i skolens priser. Beløp kan variere og endres; se Vegvesenets oppdaterte informasjon. Jeg kan ikke bestille en prøve eller se søknaden din.", rulesSource, true);
  if (has(/mork|trafikant i morket/) && has(/sommer|vinter|nar|periode|ma jeg|trenger jeg|november|mars/)) return fact("dark_rules");
  if (has(/25|fritatt|fritak/) && has(/grunnkurs|\btgk?\b|forstehjelp/)) return pricing ? fact("firstaid", "tg_rules") : fact("tg_rules");
  if (has(/alder|gammel|\b(?:15|16|17|18|20|21|24) ar\b|aldersgrense|ovelseskjor|ledsager|utenlandsk|forerrett|lov a kjore|hvor tung|4250|3500|4 250|3 500|kilo|\bkg\b/))
    return make("Aldersgrenser, øvelseskjøring og hvilken førerrett du har, avhenger av klassen og tidligere opplæring. Kontroller kravene hos Statens vegvesen og få RoMa til å vurdere din situasjon; demoen kan ikke bekrefte personlig førerrett.", rulesSource, true);
  if (has(/forskjell.*(?:be|b96)|\bbe\b.*eller.*b96|b96.*eller.*\bbe\b/))
    return make("RoMa tilbyr både BE og B96. Hvilken du trenger, avhenger av bilens og tilhengerens tillatte vekter og førerretten din. Sjekk vognkortene og Statens vegvesens veiledning; RoMa kan hjelpe deg å velge riktig kurs. Kjøretime er oppført til 900 kr for begge.", rulesSource);
  if (has(/pameld|melde.*pa|book|bestill|kalender|kursoversikt/) && !pricing) return fact("booking");
  if (has(/pakke|pakketilbud|superpakken|startpakken|obligatorisk a1|(?:5|10|20) kjoretimer/)) {
    const ids = [];
    if (classes.includes("A1")) ids.push("a1_packages");
    if (classes.includes("A2")) return uncertain("Jeg har ikke en verifisert pakkepris for å ta A2 direkte. Pakken til 14 550 kr gjelder konvertering fra A1 etter minst 2 år, ikke vanlig A2-opplæring fra start.");
    if (classes.includes("A")) ids.push("a_package");
    if (moped) ids.push("moped_package");
    if (classes.includes("BE")) ids.push("be_package");
    if (classes.includes("B96")) return uncertain("Jeg har ikke en verifisert B96-pakkepris. De enkelte kurs- og timeprisene står i prislisten.");
    if (bil) ids.push("bil_packages");
    if (ids.length) return fact(...ids);
    return make("Hvilken klasse ønsker du pakkepris for: bil B/manuell/automat, A1, A2, A, moped AM146 eller BE? Pakkene har ulikt innhold, og jeg vil ikke gi deg prisen for feil klasse.", priceSource);
  }
  if (has(/oppvarming/)) return fact("warmup");
  if (has(/oppkjor|forerprove|leie.*(bil|sykkel|henger)/)) return fact("test_rental");
  if (has(/trinnvurder|trinn ?[23]/) && pricing) return fact("steps");
  if (has(/sikkerhetskurs.*(?:vei|veg)|langkjor|landevei|landeveg/)) {
    if (!classes.length || classes.includes("MC") || classes.includes("BE") || classes.includes("trailer")) return fact("road_prices");
    const values = {B:"bil B: 11 700 kr", A1:"A1: 5 700 kr (225 minutter)", A2:"A2: 5 700 kr (225 minutter)", A:"A: 8 600 kr (360 minutter)", AM146:"moped AM146: 2 600 kr (180 minutter)", B96:"B96: 2 850 kr (135 minutter)"};
    return make(`Sikkerhetskurs på veg er oppført til ${classes.map(c => values[c]).filter(Boolean).join("; ")}. Kontroller riktig klasse og pris før bestilling.`, priceSource);
  }
  if (has(/glattkjor|ovingsbane|presis kjoreteknikk|\bbane\b|naf/)) {
    if (classes.includes("A1") && !classes.includes("A") && !classes.includes("A2")) return uncertain("A1-listen viser sikkerhetskurs i trafikk og på veg, ikke samme presisjonskurs som A2/A. Ikke bruk A2/A-prisen for A1.");
    if (mc && bil) return fact("bil_track", "mc_track");
    if (mc) return fact("mc_track");
    if (bil) return fact("bil_track");
    return make("Mener du bil B eller MC A2/A? Bilens øvingsbanekurs står til 6 800 kr inkludert NAF-gebyr; presis kjøreteknikk for A2/A står til 5 200 kr inkludert NAF-gebyr.", priceSource);
  }
  if (has(/sikkerhetskurs i trafikk/)) {
    if (moped) return fact("traffic_moped");
    if (classes.includes("A1")) return fact("traffic_a1");
    return make("Mener du A1 eller moped AM146? A1-kurset står til 4 950 kr, og AM146-kurset til 2 600 kr. Begge er oppført til 180 minutter. For andre klasser eller fritak må RoMa bekrefte opplegget.", priceSource, true);
  }
  if (has(/sikkerhetskurs/)) return make("Mener du sikkerhetskurs i trafikk, på bane / presis kjøreteknikk eller på veg? Oppgi også førerkortklassen, så får du riktig kurspris.", priceSource);
  const courseIds = [];
  if (has(/mork|trafikant i morket/)) courseIds.push("dark");
  if (has(/forstehjelp|first aid/)) courseIds.push("firstaid");
  if (has(/lastsik|sikring.*last/)) courseIds.push("load");
  if (has(/trafikalt grunnkurs|trafikale grunnkurs|\btgk?\b/)) courseIds.push("tg");
  if (has(/grunnkurs|mc.kurs/)) {
    if (mc) courseIds.push("mc_basic");
    else if (moped) courseIds.push("moped_basic");
    else if (!courseIds.length) return make("Mener du trafikalt grunnkurs (2 100 kr uten mørkekjøring), grunnkurs MC (1 490 kr) eller grunnkurs moped (990 kr)? De er forskjellige kurs.", priceSource);
  }
  if (courseIds.length) return fact(...courseIds);
  if (has(/kjoretime|kjoretima|kjoretimer|driving lesson|kjoeretime|kjoring.*(?:kveld|helg)|kjore.*(?:kveld|helg)/)) {
    const ids = [];
    if (bil) ids.push("bil_lesson");
    if (mc) ids.push("mc_lesson");
    if (trailer) ids.push("trailer_lesson");
    if (moped) ids.push("moped_lesson");
    return fact(...(ids.length ? ids : ["lesson_overview"]));
  }
  if (has(/manuell|automat|kode 78|girvalg/)) return fact("transmission");
  if (has(/komme.*gang|kommer.*gang|starte|forste steg|trinnene|fire trinn|opplaer.*foregar/)) return fact("path");
  if (has(/pameld|melde.*pa|book|bestill|kalender|kursoversikt/)) return fact("booking");
  if (has(/forskjell/) && mc) return make("RoMa tilbyr A1 (lett motorsykkel), A2 (mellomtung motorsykkel) og A (tung motorsykkel). Kravene til alder, effekt og tidligere førerrett varierer. RoMa kan hjelpe deg å velge klasse; kontroller førerretten hos Statens vegvesen.", rulesSource);
  if (pricing && classes.length) return fact("total");
  if (has(/tilbyr|klasser|hvilke kurs|har dere|om roma|hvem er roma/) && (classes.length || has(/klasser|hvilke kurs|om roma|hvem er roma|tilbyr roma/))) return fact("identity");
  if (has(/kan jeg ta|vil ta|onsker.*lappen/) && classes.length) return fact("identity");
  if (classes.length && has(/^(?:hva med |og |(?:klasse )?)(?:a[12]?|b(?:aut|96|e)?|am146|mc|bil|moped)[?!. ]*$/)) return make(`Jeg kan hjelpe med ${classes.join(" / ")} hos RoMa. Vil du vite om kjøretime, pakke, grunnkurs eller påmelding? Skriv gjerne hele spørsmålet, for eksempel «Hva koster kjøretime ${classes[0]}?».`, priceSource);
  if (pricing || has(/prisliste/)) return make("Se RoMas publiserte prisliste. Du kan også spørre om en bestemt klasse og tjeneste, for eksempel «Hva koster en kjøretime A2?» eller «Hva koster mørkekjøring?».", priceSource);
  if (/^(hei|heisann|hallo|hello|hi)[!. ]*$/.test(t)) return make("Hei! Jeg kan hjelpe med RoMas bil- og MC-opplæring, tilhenger, moped, kurs og priser. Hva lurer du på?", "https://romatrafikkskole.no/");
  if (/^(takk|tusen takk|takk for hjelpen|ha det)[!. ]*$/.test(t)) return make("Bare hyggelig! Når du er klar, finner du kurs og påmelding hos RoMa.", courseSource);
  return uncertain("Jeg finner ikke et sikkert svar på akkurat det i demoens verifiserte kilder. Prøv gjerne å nevne førerkortklasse og hva du lurer på.");
}

module.exports = { answer, classesIn, normal };
