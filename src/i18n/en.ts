/** The connector's words in English; es.ts and nl.ts have every key (test/unit/i18n.test.ts checks). */
export default {

  // The consent page (the Worker's own page, before the portal signs the person in).
  'consent.title': 'Connect {client} to Huishouden?',
  'consent.body': '{client} will be able to read and change your household\'s things in Huishouden as you: the calendar, to-dos, shopping lists, pets, home, bills and contacts, and Health for the people you care for. The household\'s rules still decide everything, exactly as in the apps.',
  'consent.redirect': 'Access goes to {host}.',
  'consent.loopback': 'This sends access to an app on your own computer. Continue only if you just started connecting from it.',
  'consent.unverified': 'This app named itself; Huishouden can\'t check that name.',
  'consent.verified': 'Published by {domain}.',
  'consent.continue': 'Continue with Google',
  'consent.cancel': 'Cancel',
  'consent.revoke': 'You can disconnect it any time from the account menu: Use with your AI assistant.',
  'consent.error': 'This connection request can\'t be used: {reason}. Start again from your assistant.',
  'consent.expired': 'This page has expired or was opened in another browser. Start again from your assistant.',

  // A tool call refused for Firestore reads (src/reads.ts): the answer's text, `firestore-quota` in its data.
  'quota.connection': 'This assistant has used its share of Huishouden for today. It resets at midnight Pacific time; the apps keep working meanwhile.',
  'quota.connector': 'AI assistants have used their share of Huishouden for today. It resets at midnight Pacific time; the apps keep working meanwhile.',
  'quota.project': 'Huishouden has used its free daily allowance and can\'t read anything until midnight Pacific time. Try again after that.',
} as const;
