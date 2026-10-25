(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.JemlioBusinessSupport = api;
})(typeof window === 'object' ? window : this, function () {
  'use strict';
  // Public business facts, shared with the landing page. No storage or network.
  const greeting = 'Hei! Jeg kan forklare Jemlios arbeid med B2B-salg og industriell sourcing. Hva er aktuelt for dere — nye kunder eller nye leverandører?';
  const questions = ['Hvordan hjelper dere med B2B-salg?', 'Hva er industriell sourcing?', 'Hvordan starter vi et samarbeid?'];
  const contact = '[Skriv til Matteus](mailto:hei@jemlio.com?subject=Mulig%20samarbeid%20med%20Jemlio)';
  const salesQuestions = ['Hvilke leverandører passer dette for?', 'Hvordan kvalifiserer dere kunder?', 'Hva koster et samarbeid?'];
  const sourcingQuestions = ['Hva slags komponenter ser dere etter?', 'Hva trenger dere fra en innkjøper?', 'Kan vi kontakte dere som produsent?'];
  const facts = Object.freeze({
    identity: 'Jemlio fokuserer nå på to områder: B2B-salg for norske tjenesteleverandører og industriell sourcing mellom Norge, Polen og Europa. Begge områdene er i etableringsfasen. Matteus følger opp mulige samarbeid personlig.',
    sales: 'Vi utforsker salgssamarbeid med norske tjenesteleverandører, blant annet innen IT. Arbeidet kan omfatte å finne relevante bedrifter, avklare behov, kvalifisere mulige kunder og avtale møter. Videre salgsoppfølging og ansvar avtales for hvert samarbeid. ' + contact + ' og fortell hva dere leverer og hvem dere ønsker å nå.',
    qualification: 'Vi starter med en avtalt målgruppe og tydelige kriterier. I dialogen avklares bedriftens behov, om tjenesten passer, hvem som tar beslutningen og når et eventuelt kjøp kan være aktuelt. Et møte skal ha en konkret grunn. Kriterier og overlevering avtales med leverandøren før oppstart.',
    audience: 'På salgssiden utforsker vi samarbeid med norske tjenesteleverandører, blant annet innen IT-drift og IT-tjenester. Om det passer, avhenger av tjenesten, målgruppen og salgsprosessen. ' + contact + ' med en kort beskrivelse av tjenestene deres.',
    sourcing: 'Industriell sourcing betyr å lete etter aktuelle produsenter for et konkret innkjøpsbehov. Jemlio kartlegger europeiske produsenter av maskinerte og spesialtilpassede komponenter, med særlig interesse for Polen og Norge. Krav til kvalitet, kapasitet, pris og levering må avklares og bekreftes for det enkelte oppdrag.',
    components: 'Fokuset er maskinerte og spesialtilpassede industrikomponenter, for eksempel deler der kjøperen har en tegning eller en spesifikasjon. Vi undersøker aktuelle produsenter ut fra behovet. Vi har ikke en bekreftet produktkatalog eller produksjonskapasitet å love.',
    buyer: 'Start med en kort, ikke-konfidensiell beskrivelse av komponenten: materiale, produksjonsmetode, omtrentlige mengder, toleranser og ønsket levering. Oppgi også eventuelle dokumentasjons- eller sertifikatkrav. Tegninger og konfidensielle detaljer deles først gjennom en avtalt kanal. ' + contact + ' for å avklare om vi kan hjelpe.',
    supplier: 'Ja, aktuelle europeiske produsenter kan kontakte oss. Fortell om produksjonsmetoder, materialer, dokumenterbare kvalitetskrav, kapasitet og aktuelle typer oppdrag. Leverandørnettverket er under kvalifisering; kontakt gir ikke automatisk partnerstatus eller en ordre. ' + contact + '.',
    quality: 'Kvalitet, toleranser, dokumentasjon, sertifiseringer, kapasitet og levering må kontrolleres mot kjøperens krav. Vi oppgir ikke en produsent som godkjent eller sertifisert uten dokumentasjon. Endelig leverandørvalg, avtaler og ansvar må avklares før en bestilling.',
    pricing: 'Det er ingen offentlig fastpris for B2B-salg eller sourcing. Opplegg, omfang, ansvar og honorar avtales skriftlig per samarbeid før arbeidet starter. Det gjelder også eventuell provisjon eller betaling knyttet til et resultat. ' + contact + ' med behovet deres, så kan prisgrunnlaget avklares.',
    process: 'Først avklarer vi behovet: nye kunder eller aktuelle produsenter. Deretter vurderer vi om muligheten passer, og hva som må undersøkes. Før oppstart avtaler vi omfang, ansvar, honorar og neste handling skriftlig. ' + contact + ' og beskriv bedriften og behovet kort.',
    status: 'Begge satsingsområdene er i etableringsfasen. Vi har ikke dokumenterte resultater fra disse områdene eller et ferdig kvalifisert leverandørnettverk å vise til ennå. Vi lover ikke salg, inntekter, produksjonskapasitet, pris eller levering før det er grunnlag for det.',
    contact: 'Du kan kontakte Matteus på [hei@jemlio.com](mailto:hei@jemlio.com?subject=Mulig%20samarbeid%20med%20Jemlio). Fortell kort om bedriften og om det gjelder salg, innkjøp eller produsentkontakt. Chatten sender ingen e-post eller forespørsel og booker ikke møter.',
    demos: 'De tidligere demoene for VVS, trafikkskole, optiker og oppfølging finnes fortsatt. [Åpne produktdemoene](https://www.jemlio.com/#demo). De er separate fra B2B-salg og industriell sourcing, og eksemplene sender ingen SMS eller e-post.',
    limits: 'Jeg forklarer de to satsingsområdene og viser riktig kontaktpunkt. Jeg kan ikke kontakte bedrifter, motta et oppdrag, bekrefte en pris, booke et møte eller legge inn en bestilling. ' + contact + ' for en konkret avklaring.'
  });
  const normal = value => String(value || '').normalize('NFKC').toLowerCase().replace(/æ/g,'ae').replace(/ø/g,'o').replace(/å/g,'a').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,' ').trim();
  function answer(message) {
    const raw = String(message || '').slice(0, 2000), t = normal(raw), has = re => re.test(t);
    const make = (reply, unsure = false, suggestions = questions) => ({reply, unsure, suggestions: [...suggestions]});
    const fact = (id, suggestions) => make(facts[id], false, suggestions);
    if (has(/ignorer|ignore|system.?prompt|api.?key|api.?nokkel|passord|password|hemmelig|override|lat som|pretend|vis.*(?:andre|annen).*kunde/)) return make('Jeg kan bare forklare Jemlios offentlige tjenester. Jeg har ikke tilgang til interne opplysninger, kundedata eller handlinger.',true);
    if (/[\w.+-]+@[\w.-]+\.[a-z]{2,}/i.test(raw) || /\b(?:\d[\s-]?){8,11}\b/.test(raw) || has(/jeg heter|mitt navn|mitt (?:nummer|telefon)|personnummer|kortnummer|ring meg|kontakt meg|call me/)) return make('Ikke legg inn personopplysninger eller konfidensielle detaljer her. Chatten sender ingen kontaktforespørsel. '+contact+' på e-post for videre dialog.',true);
    if (has(/personvern|privacy|gdpr|lagr|slett.*(?:data|opplysning)|logg/)) return make('Spørsmål om de to satsingsområdene i denne hjørnechatten besvares i nettleseren. Spørsmål om produktdemoene sendes til serveren. Samtalen holdes i den åpne siden og tømmes ved omlasting; den oppretter ingen kundehenvendelse. [Les personverninformasjonen](https://www.jemlio.com/privacy).');
    if (has(/send.*(?:e-post|epost|mail|melding)|book.*(?:mote|meeting)|bestill.*(?:del|ordre)|legg.*bestilling|betal.*(?:her|na|med kort)|send.*tilbud/)) return fact('limits');
    if (has(/garanti|garanter|referanse|resultat|hvilke.*(?:partnere|kunder)|hvem.*(?:partner|kunde)|etablert|status|allerede.*(?:partner|avtale)/)) return fact('status');
    if (has(/sertifi|kvalitet|kvalifiser.*(?:produsent|leverandor)|kvalifisering.*leverandor|iso\b|tolerans|dokumentasjon|quality/)) return fact('quality',sourcingQuestions);
    if (has(/prisforslag|\bvvs\b|rorlegger|ubesvart|sms|cordel|smartdok|oppfolging.*(?:demo|henvendelse)|booking.*demo/)) return null; // Preserve the existing product answer service.
    if (has(/demo|chatbot|trafikkskole|optiker|gammel|tidligere.*produkt/)) return fact('demos');
    if (has(/pris|koster|kostnad|honorar|provisjon|kommisjon|price|how much|990|900|betaling/)) return fact('pricing');
    if (has(/(?:vi er|som|jeg er).*(?:produsent|leverandor av.*(?:komponent|del))|bli.*(?:produsent|leverandor|partner)|supplier|manufacturer/)) return fact('supplier',sourcingQuestions);
    if (has(/trenger.*(?:fra|innkjop)|hva.*(?:sende|oppgi|informasjon)|innkjoper|tegning|spesifikasjon|material|mengde|volum|foresporsel.*(?:komponent|del)/)) return fact('buyer',sourcingQuestions);
    if (has(/komponent|cnc|maskiner|fres|drei|deler|produkter/)) return fact('components',sourcingQuestions);
    if (has(/sourcing|polen|polsk|europe|europa|produsent|leverandorsok|innkjop|nye leverandorer/)) return fact('sourcing',sourcingQuestions);
    if (has(/kvalifiser|kvalifisering|mote|prospekt|prospektering|lead/)) return fact('qualification',salesQuestions);
    if (has(/hvilke.*(?:bedrift|leverandor)|hvem.*(?:passer|kan.*bruke)|\bit\b|it-drift|it-tjenest|tjenesteleverandor|malgruppe/)) return fact('audience',salesQuestions);
    if (has(/b2b|salg|nye kunder|flere kunder|sales|outreach|kundeutvikling/)) return fact('sales',salesQuestions);
    if (has(/samarbeid|komme.*gang|kommer.*gang|starte|oppstart|neste steg|hvordan.*(?:jobber|fungerer)|process|start/)) return fact('process');
    if (has(/kontakt|e-post|epost|\bmail\b|telefon|matteus|hvem.*(?:driver|star bak)/)) return fact('contact');
    if (has(/jemlio|nova dynamics|hvem er|hva gjor|hva tilbyr|tjenester|what.*(?:do|offer)/) || /^(hei|heisann|hallo|hello|hi)[!. ]*$/.test(t)) return fact('identity');
    if (/^(takk|tusen takk|thanks)[!. ]*$/.test(t)) return make('Bare hyggelig. '+contact+' når dere vil avklare en konkret mulighet.');
    return make('Det har jeg ikke bekreftede opplysninger om. Jeg kan forklare B2B-salg, industriell sourcing eller hvordan dere tar kontakt. '+contact+' for en konkret avklaring.',true);
  }
  return Object.freeze({answer, greeting, questions:Object.freeze(questions)});
});
