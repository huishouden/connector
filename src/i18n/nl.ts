import type en from './en';

const nl: Record<keyof typeof en, string> = {
  'consent.title': '{client} met Huishouden verbinden?',
  'consent.body': '{client} kan dan namens jou de zaken van je huishouden in Huishouden bekijken en veranderen: de agenda, taken, boodschappenlijsten, huisdieren, het huis, rekeningen en contacten, en Gezondheid voor de mensen voor wie je zorgt. De regels van het huishouden blijven alles bepalen, precies zoals in de apps.',
  'consent.redirect': 'De toegang gaat naar {host}.',
  'consent.loopback': 'Dit stuurt de toegang naar een app op je eigen computer. Ga alleen verder als je net vanuit die app bent begonnen met verbinden.',
  'consent.unverified': 'Deze app heeft zichzelf een naam gegeven; Huishouden kan die niet controleren.',
  'consent.verified': 'Gepubliceerd door {domain}.',
  'consent.continue': 'Doorgaan met Google',
  'consent.cancel': 'Annuleren',
  'consent.revoke': 'Je kunt de verbinding altijd verbreken via het accountmenu: Gebruiken met je AI-assistent.',
  'consent.error': 'Dit verbindingsverzoek kan niet worden gebruikt: {reason}. Begin opnieuw vanuit je assistent.',
  'consent.expired': 'Deze pagina is verlopen of in een andere browser geopend. Begin opnieuw vanuit je assistent.',

  'quota.connection': 'Deze assistent heeft zijn deel van Huishouden voor vandaag gebruikt. Dat begint opnieuw om middernacht Pacific-tijd; de apps blijven intussen gewoon werken.',
  'quota.connector': 'AI-assistenten hebben hun deel van Huishouden voor vandaag gebruikt. Dat begint opnieuw om middernacht Pacific-tijd; de apps blijven intussen gewoon werken.',
  'quota.project': 'Huishouden heeft zijn gratis dagelijkse tegoed gebruikt en kan tot middernacht Pacific-tijd niets lezen. Probeer het daarna opnieuw.',
};

export default nl;
