"use strict";

// Public example tenants are explicitly isolated from every real client's KB.
// No model, retrieval fallback, I/O, analytics, logging or personal-data capture.
const knowledge = Object.freeze({
  jemlio: require("./kb.json"),
  "jemlio-driving-demo": require("../jemlio-driving-demo/kb.json"),
  "jemlio-optician-demo": require("../jemlio-optician-demo/kb.json")
});
const labels = Object.freeze({
  "jemlio-driving-demo": "Eksempel: trafikkskole — fiktiv virksomhet.",
  "jemlio-optician-demo": "Eksempel: optiker — fiktiv virksomhet."
});
const suggestions = Object.freeze({
  jemlio: ["Hva kan chatten hjelpe med?", "Kan jeg få en gratis mini-demo?", "Hva koster Jemlio?"],
  "jemlio-driving-demo": ["Hva koster en kjøretime?", "Tilbyr dere automatgir?", "Hvordan bestiller jeg time?"],
  "jemlio-optician-demo": ["Hva koster en synsundersøkelse?", "Kan jeg få hjelp med kontaktlinser?", "Hvordan bestiller jeg en synstest?"]
});
const normal = value => String(value || "").normalize("NFKC").toLowerCase()
  .replace(/æ/g, "ae").replace(/ø/g, "o").replace(/å/g, "a")
  .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
  .replace(/\s+/g, " ").trim();

function answer(client, message) {
  if (typeof client !== "string" || !Object.hasOwn(knowledge, client)) return null;
  const raw = String(message || "").slice(0, 2000);
  const t = normal(raw);
  const has = re => re.test(t);
  const asksPrice = has(/pris|koster|kostnad|hvor mye|price|how much/);
  const asksDuration = has(/minutt|varighet|hvor (?:lang|lenge)/);
  const make = (reply, unsure = false) => ({
    reply: labels[client] ? `${labels[client]}\n\n${reply}` : reply,
    unsure,
    suggestions: [...suggestions[client]]
  });
  const fact = (...ids) => make(ids.map(id => knowledge[client].find(row => row.id === id).a).join("\n\n"));
  const fallback = () => make(client === "jemlio"
    ? "Det har jeg ikke bekreftede opplysninger om. Jeg kan forklare den tilgjengelige chatten eller vise hvordan du ber om en gratis mini-demo. For andre spørsmål: novadynamics7@gmail.com."
    : "Det er ikke beskrevet i dette fiktive eksemplet, så jeg vil ikke gjette. Prøv et av spørsmålene under. Hos en virkelig bedrift må slike detaljer bekreftes direkte med bedriften.", true);

  // Safety and action limits take precedence over informational topics.
  // Responses never echo any supplied name, contact detail or sensitive text.
  if (has(/ignore|ignorer|system.?prompt|api.?key|api.?nokkel|passord|password|hemmelig|override|lat som|pretend|instruksjon|vis.*(?:annen|andre).*kunde/))
    return make("Jeg svarer bare ut fra informasjonen som hører til denne demonstrasjonen. Jeg kan ikke hente hemmeligheter, andre kunders opplysninger, endre tilbud eller utføre handlinger.", true);
  if (/[\w.+-]+@[\w.-]+\.[a-z]{2,}/i.test(raw) || /\b(?:\d[\s-]?){8,11}\b/.test(raw) || has(/jeg heter|mitt navn|min adresse|mitt (?:nummer|telefon|mobil)|fodsel|personnummer|kortnummer|ring meg|ringe meg|kontakt meg|lagre.*(?:navn|nummer|epost)|send.*(?:navn|nummer|epost)/))
    return make("Ikke legg inn navn, telefonnummer, e-postadresse eller andre personopplysninger her. Chatten oppretter ingen kundehenvendelse, videresender ingen opplysninger og avtaler ingen tilbakeringing. Bruk bedriftens vanlige kontaktkanal. For Jemlio: novadynamics7@gmail.com.", true);
  if (has(/personvern|privacy|gdpr|lagr|logg|sporing|posthog|slett.*(?:data|opplysning)|delete.*data|opptak/))
    return make("Spørsmålet sendes til serveren for å gi deg et svar. Denne chatten er ikke et skjema for kundeopplysninger eller en kanal for sletteforespørsler. Ikke del personopplysninger. For spørsmål om personvern, kontakt Jemlio på novadynamics7@gmail.com.");
  if (has(/send.*(?:mail|e-post|epost|melding)|videresend|betaling|betal.*(?:her|chat)|kortbetaling/))
    return make("Chatten sender ikke meldinger, videresender ikke opplysninger og tar ikke betaling. Den gir informasjon og kan vise videre til riktig kontaktpunkt. For Jemlio: novadynamics7@gmail.com.");
  if (has(/hva kan du|hvem er du|hva.*demo.*(?:gjore|kan)|er du.*(?:bot|robot)/)) return fact("limits");

  if (client === "jemlio") {
    // Asking how to request a demo is different from asking the chat to book.
    // The demo answer still makes clear that the visitor must send the email.
    if (has(/demo/) && has(/gratis|mini.?demo|\b(?:fa|far|lage|be om|bestill(?:e|er)?|book(?:e|er)?|prove|teste)\b/)) return fact("demo");
    if (has(/book|bestill|reserver|kundeopplysn|lead.?capture|leadfangst|kundeinnsamling|samle.*(?:kunde|kontakt)|registrere.*(?:kunde|kontakt)|automatisk.*(?:booking|bestill|epost|e-post)|integrasjon|kalender|crm|airtable|sms|analyse|statistikk|dashboard|rapport/)) return fact("limits");
    if (has(/garanti|garanter|omsetning|flere kunder|salgstall|konvertering/)) return fact("results");
    if (has(/referanse|ekte kunde|kundeliste|hvem.*bruker|hvor mange.*kunde|fiktiv|oppdikt|virkelig/)) return fact("examples");
    if (has(/pris|koster|kostnad|hvor mye|price|how much|abonnement/)) return fact("pricing");
    if (has(/mini.?demo|gratis.*demo|prove.*(?:chat|demo)|fa.*demo/)) return fact("demo");
    if (has(/tilpass|farge|design|logo|utseende|tema|min bedrift|var bedrift/)) return fact("tailoring");
    if (has(/komme.*gang|kommer.*gang|oppstart|sette opp|installasjon|starte/)) return fact("setup");
    if (has(/kontakt|e-post|epost|\bmail\b|telefon|ringe/)) return fact("contact");
    if (has(/apningstid|kontortid|hvor.*(?:holder|ligger)|adresse/)) return fallback();
    if (has(/hva.*(?:er|gjor).*jemlio|hvem.*jemlio|nova dynamics|navnebytte/)) return fact("identity");
    if (has(/hva.*(?:chat|hjelp|funksjon)|hvordan.*(?:virker|fungerer)|tjeneste|apningstid|sporsmal|egen informasjon/)) return fact("features");
    if (/^(?:hei|heisann|hallo|hello|hi)[!. ]*$/.test(t)) return fact("identity");
    if (/^(?:takk|tusen takk|ha det)[!. ]*$/.test(t)) return make("Bare hyggelig! Vil du se chatten med bedriftens egen informasjon, kan du be om en gratis mini-demo på novadynamics7@gmail.com.");
    return fallback();
  }

  if (client === "jemlio-optician-demo" && has(/symptom|smerte|vondt|rode? oye|rodt oye|rodhet|torr|svie|klor|kloring|synstap|uklar|takete|dobbeltsyn|lysblink|floater|ser.*(?:darlig|prikk|flekk)|diagnos|behandl|medisin|sykdom|migrene|hodepine|helse|akutt|blind|glaukom|staer|hva feiler|(?:kan|bor).*jeg.*(?:bruke|ha|velge).*(?:brill|linse)|(?:trenger jeg|bor jeg ta|ma jeg ta).*(?:undersok|brill|linse)|vurder.*(?:syn|oy)/)) return { ...fact("health"), unsure: true };
  if (client === "jemlio-driving-demo" && has(/forerrett|lov.*kjore|aldersgrense|ovelseskjor|vegvesen|helse|promille|fritak|fritatt|kode 78|garanti|bestatt|bestar|totalpris|hele.*(?:lappen|forerkort)|hvor mange.*time/)) return fallback();
  // Unknown conditions must not inherit the price/duration of a basic example.
  if (has(/paske|jul|nyttar|helligdag|ferie|\b17\.?\s*mai\b|stengt.*(?:dato|uke)/)) return fallback();
  if (client === "jemlio-driving-demo" && has(/\ba[12]?\b|\bbe\b|\bb96\b|\bmc\b|motorsykkel|moped|tilhenger|traktor|buss|lastebil|grunnkurs|morkekjor|glattkjor|bane|oppkjor|forerprove|pakke|rabatt|delbetal|kveld|helg|henting|hentested|dobbel|90\s*minutt/)) return fallback();
  if (client === "jemlio-optician-demo" && has(/brille|solbrill|barn|forsikring|rabatt|refusjon|henvis|resept|attest|garanti/)) return fallback();
  if (asksPrice && has(/avbestill|avlys|endre|gebyr|kontaktlinse|\blinser?\b|lordag|sondag|helg|kveld/)) return fallback();
  const bookingQuestion = has(/book|bestill|reserver|pameld|melde.*pa|avbestill|avlys|endre.*time|ledig|timebok|ventetid|neste kurs|kursdato|(?:kan jeg|kan vi|onsker|vil gjerne|trenger).*(?:fa|ha|en).*(?:time|synstest|synsundersok)/);
  if (bookingQuestion) {
    if (asksPrice && client === "jemlio-driving-demo" && has(/kjoretime|biltime|klasse b/)) return fact("lesson", "booking");
    if (asksPrice && client === "jemlio-optician-demo" && has(/synstest|synsundersok/)) return fact("examination", "booking");
    return fact("booking");
  }
  if (client === "jemlio-optician-demo" && has(/kontaktlinse|\blinser?\b/) && !asksPrice) return fact("contact_lenses");
  if (has(/\bkontakt(?:e|er)?\b|telefon|e-post|epost|\bmail\b|adresse|hvor.*(?:ligg|holder)|hjemmeside|nettside|ringe|ansatt/)) return fact("contact");
  if (!asksPrice && !asksDuration && has(/apningstid|kontortid|apent|apne|stengt|kontoret|lordag|sondag|opening hours/)) return fact("hours");
  if (has(/fiktiv|oppdikt|ekte.*(?:skole|optiker|bedrift)|virkelig.*(?:skole|optiker|bedrift)/)) return fact("identity");
  if (/^(?:hei|heisann|hallo|hello|hi)[!. ]*$/.test(t)) return fact("identity");
  if (/^(?:takk|tusen takk|ha det)[!. ]*$/.test(t)) return make("Bare hyggelig! Velg gjerne et annet eksempelspørsmål for å prøve demonstrasjonen.");

  if (client === "jemlio-driving-demo") {
    const asksLessonFact = has(/kjoretime|biltime|klasse b/) && (asksPrice || asksDuration);
    const barePriceQuestion = /^(?:priser?|hva koster det|hvor mye koster det)[?!. ]*$/.test(t);
    if (asksLessonFact || barePriceQuestion || /^kjoretimer?[?!. ]*$/.test(t)) return fact("lesson");
    if (has(/automat|manuell|girvalg/)) return fact("transmission");
    if (has(/klasse b|hvilke klasser|hva.*tilbyr|opplaering|tilbud/)) return fact("identity");
    return fallback();
  }

  // Optician examples have no prices for glasses, lenses or treatments.
  if (has(/kontaktlinse|linser?/)) return fallback();
  if (has(/pris|koster|kostnad|hvor mye|price|how much/)) return has(/synsundersok|synstest|^hva koster (?:det|en undersokelse)\??$|^priser?\??$/) ? fact("examination") : fallback();
  if (has(/minutt|varighet|hvor (?:lang|lenge)/) && has(/syn|undersok|time/)) return fact("duration");
  if (has(/synsundersok|synstest/)) return fact("examination");
  if (has(/hva.*tilbyr|hvilke.*tjenester|tilbud/)) return fact("identity");
  return fallback();
}

module.exports = { answer };
