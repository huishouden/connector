# Huishouden connector

The connector is a remote [MCP](https://modelcontextprotocol.io) server. People add it to their own AI assistant (Claude,
ChatGPT, Gemini CLI or any MCP client) to use their Huishouden household from there. They can ask
"what's on today?", add groceries, log a pet's feed or a medicine dose, see upcoming bills, or look
up the medicines of someone they care for and research them in the assistant.

The connector is free, it works for any household, and each person approves it for themselves. The
household's own Firestore rules decide everything it can do, because it acts **as the signed-in
person**. It never uses a service account.

- MCP endpoint: `https://huishouden-connector.<account>.workers.dev/mcp` (Streamable HTTP).
  Staging runs at `huishouden-connector-staging.<account>.workers.dev`, against the
  `huishouden-staging` project.
- How to add it: the portal's **Use with your AI assistant** page (`/assistant`, in every app's
  account menu) shows the exact address and the steps for Claude, ChatGPT and Gemini CLI, in
  English, Spanish and Dutch.

## Tools

Every tool takes an optional `household` (the default is the one the apps open), `lang` (`en`, `es`
or `nl`; the default is the person's Huishouden language) and `time_zone` (the default is the one in
their profile). Answers are short Markdown in that language, with deep links into the apps. They
also come back as structured data. Writing tools take an optional `idempotency_key`: a retry with the
same key writes nothing new.

| Tool | Does |
|---|---|
| `households` | Who is signed in, their households and their role in each, language and time zone |
| `household_home` | The household's home address (or only its neighbourhood, when approximate) and time zone; every member reads it, helpers and kids included |
| `today` | Today's agenda (overdue, today, next 48 hours) and open to-dos, as the portal shows them |
| `calendar` | The household calendar between two days, by day |
| `todos` | Open to-dos from every app, with ids, filters and sorts, and whether this person may act on each |
| `todo_done`, `todo_cancel` | Run a to-do's Done or Cancel action exactly as the portal does (kit `todoActionOps` and `planTodo`) |
| `groceries_list`, `groceries_add`, `groceries_check` | Shopping lists, in the Groceries app's shapes (including staples) |
| `tasks_add` | A task, with an optional due date or time |
| `bills_due` | Open bills, amounts, due dates, autopay and pay links (admins and members only) |
| `pet_today`, `pet_log_feeding`, `pet_log_dose`, `pet_log_outing` | The feeding board, care reminders, medicine courses and outings (bathroom breaks, walks); logging as the Pet app does |
| `home_upkeep_due`, `home_add_event` | Upkeep jobs due and regular events; a new regular event (EventRule) or a booked visit |
| `add_appointment` | Pet, baby or car: in that app's list, on the household calendar (`private` keeps it from helpers and kids). Health: a visit in Health (kind, doctor, place or video link, what to bring, reminders, follow-up, `specialty` (medical area) and `condition` it is about; the condition and notes only from admins and member carers); its calendar item and reminders reach only the person's carers, the person and the admins |
| `contacts_search`, `contacts_add` | The household's shared contacts |
| `health_people` | The people this person looks after in Health |
| `health_medicines` | Strength, dose, schedule, prescriber, pharmacy, supply and days left, refills, notes, allergies |
| `health_history` | Given, missed and skipped doses, and adherence per medicine and overall |
| `health_due` | Today's doses, as-needed availability, refills running low |
| `health_log_dose` | Given or skipped, with Health's double-dose and as-needed guards (it asks before overriding) |
| `health_add_medicine`, `health_update_medicine` | Add or change a medicine, stop or restart it, count the supply, mark a refill ordered |
| `health_doctor_list` | Health's printable medicine list, as Markdown, with the person's current conditions for admins and member carers |
| `health_appointments` | A person's visits, coming up and past (attended or missed), with doctor (a doctor marked private only for admins and members), place, prep, reminders, follow-up and medical area; the condition it is about and the notes only for admins and member carers |
| `health_conditions` | A person's (or everyone's) conditions grouped by medical area, optionally one area ("Nan's neurology conditions"): ICD-10-CM code, status, when diagnosed, by whom and where, severity, the medicines that treat it, notes. Admins and member carers only (the person too, when a member); helper carers get none |
| `health_add_condition` | Add a condition (admins and member carers), filed under its ICD-10-CM code's medical area, else its name's, unless `specialty` says |

There are no delete tools. Every Health answer ends with a one-line note: these are the
household's own records, not medical advice.

The tools live in the kit, `@huishouden/pwa-kit/household-tools`: `hh data` (huishouden/cli) runs
the same implementation from a terminal, so the two can't drift. This repo adds the MCP server, the
sign-in, rate limits and the audit log around them, and tests every tool under the household's
rules against the emulators.

## How sign-in works

The connector speaks OAuth 2.1 as MCP clients expect: discovery (RFC 9728 and RFC 8414), dynamic
client registration and Client ID Metadata Documents, PKCE (S256), and refresh tokens. All of this
comes from [`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider).
The identity step happens on Huishouden's own site, through the same Google sign-in as every app, so
there is no OAuth client to configure and no redirect URI to register.

1. `GET /authorize` shows the connector's consent page: which app is asking, where access goes, and
   a warning for local apps. The page can't be framed and is bound to the browser.
2. **Continue** sends the browser to the portal's `/connect` page, with a state bound to that
   browser.
3. The portal signs the person in with Google (Firebase Auth) and asks them to confirm. On Allow it
   posts their Firebase refresh token to `/connect/hand-off`, from the portal's origin only. The
   connector checks the token with Firebase Auth and keeps it for two minutes under a one-time
   code, encrypted with a key only that code derives.
4. The portal sends the browser to `/connect/callback`. The connector takes the hand-off back once,
   for that state, and completes the grant. The refresh token goes into the grant's props, which
   workers-oauth-provider stores in Workers KV encrypted with a key that only the client's tokens
   unwrap.
5. On each tool call, the refresh token buys a fresh ID token (cached per isolate). Firestore REST
   is called with that ID token, so the rules apply exactly as in the apps. Each OAuth refresh also
   checks the Firebase sign-in still stands. When it doesn't, the grant ends and the assistant asks
   the person to connect again.

### `hh login`

The `hh` command line signs in through the same portal page, with a loopback address and a PKCE
proof key in place of a browser cookie (pwa-kit docs/server.md "Signing in from a command line"):

| Endpoint | Caller | Does |
|---|---|---|
| `POST /cli/hand-off` | the portal (CORS: its origin only) | Takes `{ state, codeChallenge, redirect, refreshToken }`. `redirect` must be exactly `http://127.0.0.1:<1024-65535>/callback` or `http://[::1]:<port>/callback`. Checks the refresh token with Firebase Auth, keeps it for two minutes under a one-time code (encrypted with a key only the code derives, bound to the state, the challenge and the redirect) and answers `{ code }` |
| `POST /cli/token` | `hh` (a request with an `Origin` header is refused, so no web page can spend a code) | Takes `{ code, state, code_verifier, redirect_uri }`. The first attempt uses the code up. A replayed or expired code, another state or redirect, or a verifier that doesn't match the challenge gets `invalid_grant`. Otherwise it answers the refresh token, who it is, and the project's public web config |

The browser and server halves are reusable kit modules, documented in
[pwa-kit docs/server.md](https://github.com/huishouden/pwa-kit/blob/main/docs/server.md):

| Module | Provides |
|---|---|
| `@huishouden/pwa-kit/signin-handoff` | The portal's /connect flow, and `hh login`'s |
| `@huishouden/pwa-kit/household-tools` | Every tool, shared with `hh data` |
| `@huishouden/pwa-kit/firebase-auth-rest` | Refresh token to ID token; verifying a portal ID token |
| `@huishouden/pwa-kit/firestore-rest` | Firestore as the person: get, query, atomic commit |
| `@huishouden/pwa-kit/local-clock` | The person's days on a UTC server |
| `@huishouden/pwa-kit/home` | Reading the household's home (`toHome`) |
| `@huishouden/pwa-kit/todo-core`, `/agenda-core`, `/contact-core`, `/role-core`, `/reminder-core`, `/dose`, `/visit`, `/schedule` | The data contracts and app logic |

The calendar feed reuses the same modules.

## Safety

- **Rules:** every read and write is the person's own and checked by
  [huishouden/rules](https://github.com/huishouden/rules).
  - Helpers and kids get only what isn't private, and never money.
  - Health is readable only by admins, the person's carers and the person themself. Others get
    nothing, as if the person didn't exist.
  - Records the connector creates carry `via: 'assistant'`, and the rules accept only that value.
    (`hh data` leaves it out: the person is typing.)
- **Rate limits:** each connected assistant may make 60 tool calls and 20 writes a minute (Workers
  Rate Limiting bindings).
- **Daily read budgets:** Firestore's free plan has 50,000 reads a day for every app and Worker
  together, and at that limit every read fails until midnight Pacific. The connector may use
  `FIRESTORE_CONNECTOR_READS` of them a day (4,000) and each connection `FIRESTORE_CONNECTION_READS`
  (1,000), counted per Pacific day in the `ReadBudget` Durable Object (`src/reads.ts`,
  `src/read-budget.ts`). A read is counted as pwa-kit `docs/one-site.md` "Budgets" defines it. A call
  over either budget, or one that meets Firestore's own quota, answers `firestore-quota`, as the
  calendar Worker's API does: an error result whose data is `{ error: 'firestore-quota', scope:
  'connection' | 'connector' | 'project', resetsAt }`, with text in the person's language. A budget
  met mid-call refuses the call's later reads and writes, and the whole answer is the quota's. A
  write already saved keeps its own answer. A request's tool calls run one at a time. Reads a call makes at once all go out before any is counted, so the day
  can end a call's reads over. Unset or `0`: no limit. If the Durable Object can't be reached, calls
  go ahead uncounted and a `read-budget` log line says so.
- **Audit:** each tool call is written, as the person, to
  `households/{id}/connections/{connection}/audit`: the tool, read or write, whether it worked, the
  app and record. Only that person can read it. The portal shows it under each connected assistant,
  next to **Disconnect**.
- **Revoke:** the portal calls `POST /connections/revoke` with the person's Firebase ID token. The
  connector checks the token with Firebase Auth, revokes the grant and its tokens, and removes the
  connection record. `GET /connections` lists the person's grants.
- **Logs:** each tool call logs the tool name, read or write, the outcome, the duration, the Firestore
  reads it was billed for and an error code (`firestore-quota` for a budget). Logs never contain names, emails, record ids, tokens, medicine names or what a visit is. The connector sends
  nothing to New Relic.

## Development

```sh
bun install
bun run lint      # tsc, src and tests
bun run test      # unit, Firebase Auth, hh login's endpoints, and every tool against the Firestore and Auth emulators (JDK 21)
bun run e2e       # wrangler dev against the emulators + the MCP SDK client: the whole OAuth sign-in, then tools
bun run dev       # wrangler dev (set FIREBASE_API_KEY in .dev.vars)
```

The tests use the household's real rules from huishouden/rules `main`. Set `RULES_REF` to use
another ref, or `RULES_FILE` to use a local checkout. The household in `test/fixtures/household.ts`
is invented: every role, a non-member, and Health with a carer and a non-carer.

## Deploy

```sh
bunx wrangler secret put FIREBASE_API_KEY            # the project's public web API key, once
bunx wrangler secret put FIREBASE_API_KEY --env staging
bun run deploy && bun run deploy:staging
```

The connector needs no other secrets. Workers KV (grants), the rate limits, the read budgets'
Durable Object (SQLite-backed, created by the deploy's `[[migrations]]`) and Workers itself all fit
the Cloudflare free plan.

### Deploy from GitHub Actions (optional)

CI tests main on every push and manual run. It deploys staging and then production on `main` once the `production` environment has these
secrets; until then the deploy job runs but deploys nothing, with a notice. Repository secrets of the same names also reach the job; once the environment holds the values, delete them (`gh secret delete CLOUDFLARE_API_TOKEN -R huishouden/connector`, and `gh secret delete CLOUDFLARE_ACCOUNT_ID -R huishouden/connector`). The environment itself (Settings > Environments > `production`, deployment branches: `main`) exists already.

1. Cloudflare dashboard > My Profile > API Tokens > Create Token > "Edit Cloudflare Workers"
   template, limited to this account.
2. Add the token as `CLOUDFLARE_API_TOKEN` and the account id as `CLOUDFLARE_ACCOUNT_ID`, secrets
   of the `production` environment (deployment branches: `main` alone, so no other branch's run
   can read them): `hh ops secret set connector CLOUDFLARE_API_TOKEN --env production` and
   `hh ops secret set connector CLOUDFLARE_ACCOUNT_ID --env production`, each value on stdin.

## License

Source available under [PolyForm Shield 1.0.0](LICENSE): you may use, study and modify this code
for any purpose except providing a product that competes with Huishouden.

Huishouden and its logo are the project's brand; please don't use them for other products.
