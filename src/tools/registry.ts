import { z } from 'zod';
import { withLang, type Lang } from '@huishouden/pwa-kit/i18n';
import type { LocalClock } from '@huishouden/pwa-kit/local-clock';
import { FirestoreError } from '@huishouden/pwa-kit/firestore-rest';
import { UserError, type AuditEntry, type Here, type Session } from '../context';
import { t } from '../i18n';

/** What a tool's handler has: the session, the household it acts in, and the person's clock and language. */
export interface ToolContext {
  session: Session;
  here: Here;
  clock: LocalClock;
  lang: Lang;
  /** Notes what the call touched for the audit log (`app` and record `ref`). */
  touched(app: string, ref?: string): void;
}

export interface ToolResult {
  /** Shown to the assistant: short, in the person's language, with deep links. */
  text: string;
  /** The same as data, for clients that read structured results. */
  data?: Record<string, unknown>;
  /** Refused or failed: the text says why. */
  error?: boolean;
}

export interface ToolDef<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  kind: 'read' | 'write';
  input: S;
  /** Answers about Health: every answer carries the one-line not-medical-advice note. */
  health?: boolean;
  /** Runs inside `withLang` for its rendering: build texts with `render`, which is synchronous. */
  run(ctx: ToolContext, args: z.infer<z.ZodObject<S>>): Promise<ToolResult>;
}

/** Every tool takes these: which household (the one the apps open by default) and the answer's language and time zone. */
export const common = {
  household: z.string().min(1).max(100).optional().describe('Household id or name, from `households`. Leave out for the one the apps open.'),
  lang: z.enum(['en', 'es', 'nl']).optional().describe("Answer language. Leave out to use the person's Huishouden language."),
  time_zone: z.string().max(64).optional().describe('IANA time zone such as "America/New_York". Leave out to use the one in their profile.'),
};

export const idempotency = {
  idempotency_key: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,64}$/)
    .optional()
    .describe('Any unique string for this one change. A retry with the same key does nothing new and answers the same.'),
};

export function defineTool<S extends z.ZodRawShape>(def: ToolDef<S>): ToolDef<S> {
  return def;
}

/** Text in the person's language: `fn` runs with the kit's language switched (it must not await). */
export const render = <T>(lang: Lang, fn: () => T): T => withLang(lang, fn);

/** The MCP result for a tool's answer. */
export function toMcp(result: ToolResult, lang: Lang, health = false) {
  const note = health ? `\n\n_${render(lang, () => t('health.note'))}_` : '';
  return {
    content: [{ type: 'text' as const, text: result.text + note }],
    ...(result.data ? { structuredContent: result.data } : {}),
    ...(result.error ? { isError: true } : {}),
  };
}

/** What a failure tells the assistant, in the person's language; nothing about the data. */
export function failureText(e: unknown, lang: Lang): string {
  return render(lang, () => {
    if (e instanceof UserError) return t(e.key as Parameters<typeof t>[0], e.vars);
    if (e instanceof FirestoreError) {
      if (e.code === 'permission-denied') return t('error.denied');
      if (e.code === 'unavailable') return t('error.unavailable');
    }
    return t('error.unknown');
  });
}

export type { AuditEntry };
