import { householdRole, isRestricted, type Role } from '@huishouden/pwa-kit/role-core';
import { isLang, loadLang, type Lang } from '@huishouden/pwa-kit/i18n';
import { LocalClock, isTimeZone } from '@huishouden/pwa-kit/local-clock';
import { FirestoreRest, FirestoreError, type Doc } from '@huishouden/pwa-kit/firestore-rest';

/** What the grant carries for the person (encrypted in KV by workers-oauth-provider). */
export interface GrantProps {
  uid: string;
  email: string;
  /** Firebase Auth refresh token from the portal's sign-in: buys ID tokens to act as the person. */
  refreshToken: string;
  /** This connection's id: the `connections/{id}` record and its audit log. */
  connectionId: string;
  /** The assistant's name as it registered ("Claude"), shown in the portal's list. */
  client: string;
  clientUri?: string;
  /** The language and time zone the portal's device had at sign-in, until the profile says otherwise. */
  lang?: Lang;
  timeZone?: string;
}

export interface Household {
  id: string;
  name: string;
  members: string[];
  joined: string[];
  roles?: Record<string, Role>;
  currency?: string;
  createdAt: number;
}

export function toHousehold(id: string, d: Record<string, unknown>): Household {
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  const roles = d.roles && typeof d.roles === 'object' ? (d.roles as Record<string, Role>) : undefined;
  return {
    id,
    name: typeof d.name === 'string' ? d.name : '',
    members: strings(d.members),
    joined: strings(d.joined),
    ...(roles ? { roles } : {}),
    ...(typeof d.currency === 'string' ? { currency: d.currency } : {}),
    createdAt: typeof d.createdAt === 'number' ? d.createdAt : 0,
  };
}

/** The household the apps open (`@huishouden/pwa-kit/household` pickHousehold): joined first, then oldest. */
export function pickHousehold(households: Household[], email: string): Household | null {
  const sorted = [...households].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  return sorted.find((h) => h.joined.includes(email)) ?? sorted[0] ?? null;
}

export interface Profile {
  name?: string;
  lang?: Lang;
  timeZone?: string;
}

export interface AuditEntry {
  tool: string;
  kind: 'read' | 'write';
  ok: boolean;
  app?: string;
  ref?: string;
}

/** A household the person is in, with their role there. */
export interface Here extends Household {
  role: Role;
  /** A helper or kid: reads of private-capable collections ask for `private == false`. */
  restricted: boolean;
}

/** Thrown for anything the person should hear in their language (an unknown pet, no household). */
export class UserError extends Error {
  constructor(
    readonly key: string,
    readonly vars: Record<string, string | number> = {},
  ) {
    super(key);
  }
}

/**
 * One tool call's view of the world: who is asking (their FirestoreRest access, as them), their clock
 * and language, and their households. Built per request; cheap, since reads happen on demand.
 */
export class Session {
  private householdsP: Promise<Household[]> | null = null;
  private profiles = new Map<string, Promise<Profile>>();

  constructor(
    readonly props: GrantProps,
    readonly db: FirestoreRest,
    readonly siteUrl: string,
    private readonly realNow: () => number = Date.now,
    private readonly audit: (household: string, entry: AuditEntry) => void = () => {},
  ) {}

  get email(): string {
    return this.props.email;
  }

  households(): Promise<Household[]> {
    this.householdsP ??= this.db
      .query('', 'households', { where: [{ field: 'members', op: 'ARRAY_CONTAINS', value: this.email }] })
      .then((docs) => docs.map((d) => toHousehold(d.id, d.data)));
    return this.householdsP;
  }

  /** The household `id`, or the one the apps open; throws a UserError when there is none. */
  async here(id?: string): Promise<Here> {
    const all = await this.households();
    const h = id ? all.find((x) => x.id === id || x.name.toLowerCase() === id.toLowerCase()) : pickHousehold(all, this.email);
    if (!h) throw new UserError(id ? 'error.noSuchHousehold' : 'error.noHousehold');
    const role = householdRole(h, this.email) ?? 'member';
    return { ...h, role, restricted: isRestricted(role) };
  }

  profile(householdId: string): Promise<Profile> {
    let p = this.profiles.get(householdId);
    if (!p) {
      p = this.db
        .get(`households/${householdId}/profiles/${this.email}`)
        .then((d) => {
          const data = d?.data ?? {};
          return {
            ...(typeof data.name === 'string' && data.name ? { name: data.name } : {}),
            ...(isLang(data.lang) ? { lang: data.lang } : {}),
            ...(isTimeZone(data.timeZone) ? { timeZone: data.timeZone as string } : {}),
          };
        })
        .catch(() => ({}));
      this.profiles.set(householdId, p);
    }
    return p;
  }

  /** The language to answer in: the call's, the profile's, the one at sign-in, else English. Loaded. */
  async lang(householdId: string | undefined, asked?: string): Promise<Lang> {
    const profile = householdId ? await this.profile(householdId) : {};
    const lang = isLang(asked) ? asked : (profile.lang ?? this.props.lang ?? 'en');
    await loadLang(lang);
    return lang;
  }

  async clock(householdId: string | undefined, asked?: string): Promise<LocalClock> {
    const profile = householdId ? await this.profile(householdId) : {};
    const zone = [asked, profile.timeZone, this.props.timeZone].find(isTimeZone) ?? 'UTC';
    return new LocalClock(zone, this.realNow);
  }

  /** "Sam": the profile's first name, else the email's name part, for `addedBy`. */
  async firstName(householdId: string): Promise<string> {
    const { name } = await this.profile(householdId);
    const first = (name ?? '').trim().split(/\s+/)[0];
    if (first) return first.slice(0, 40);
    const local = this.email.split('@')[0].split(/[._+-]/)[0];
    return (local.charAt(0).toUpperCase() + local.slice(1)).slice(0, 40);
  }

  link(app: string, query = ''): string {
    return `${this.siteUrl.replace(/\/$/, '')}/${app}/${query}`;
  }

  record(householdId: string, entry: AuditEntry): void {
    this.audit(householdId, entry);
  }

  /** Reads `collection` under the household, as the person may (helpers and kids only open records). */
  async openRecords(here: Here, collection: string, privateCapable: boolean, where: Parameters<FirestoreRest['query']>[2] = {}): Promise<Doc[]> {
    const filters = [...(where.where ?? []), ...(privateCapable && here.restricted ? [{ field: 'private', op: 'EQUAL' as const, value: false }] : [])];
    return this.db.query(`households/${here.id}`, collection, { ...where, where: filters });
  }
}

export const isDenied = (e: unknown) => e instanceof FirestoreError && e.code === 'permission-denied';
