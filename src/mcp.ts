import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker-provider.js';
import { FirestoreError } from '@huishouden/pwa-kit/firestore-rest';
import { FirebaseAuthError } from '@huishouden/pwa-kit/firebase-auth-rest';
import type { Lang } from '@huishouden/pwa-kit/i18n';
import { UserError, type AuditEntry, type Session } from './context';
import { failureText, render, toMcp, type ToolDef } from './tools/registry';
import { calendar, householdHome, households, today, todos } from './tools/overview';
import { groceriesAdd, groceriesCheck, groceriesList, tasksAdd, todoCancel, todoDone } from './tools/lists';
import { billsDue } from './tools/money';
import { petLogDose, petLogFeeding, petToday } from './tools/pet';
import { homeAddEvent, homeUpkeepDue } from './tools/home';
import { addAppointment, contactsAdd, contactsSearch } from './tools/people';
import { healthAddMedicine, healthDoctorList, healthDue, healthHistory, healthLogDose, healthMedicines, healthPeople, healthUpdateMedicine } from './tools/health';
import { t } from './i18n';

/** Every tool, in the order clients list them. */
export const TOOLS: ToolDef[] = [
  households,
  householdHome,
  today,
  calendar,
  todos,
  todoDone,
  todoCancel,
  groceriesList,
  groceriesAdd,
  groceriesCheck,
  tasksAdd,
  billsDue,
  petToday,
  petLogFeeding,
  petLogDose,
  homeUpkeepDue,
  homeAddEvent,
  addAppointment,
  contactsSearch,
  contactsAdd,
  healthPeople,
  healthMedicines,
  healthHistory,
  healthDue,
  healthLogDose,
  healthAddMedicine,
  healthUpdateMedicine,
  healthDoctorList,
] as ToolDef[];

export const INSTRUCTIONS = [
  "Huishouden is this person's household organiser: a shared calendar and to-do list fed by apps for groceries, tasks, pets, a baby, the house, cars, bills and Health (medicines for the people they care for).",
  'Every call acts as the signed-in person; the household\'s own rules decide what they may read and change, so a refusal means their role does not allow it.',
  'Start with `today` for "what\'s on today?", and use `households` when they belong to more than one household.',
  "Answers come in the person's Huishouden language with links into the apps; dates and times are in their time zone.",
  'Health answers are the household\'s own records, not medical advice; research on medicines happens here in the assistant. Before logging a dose, respect the double-dose and as-needed guards: if a call returns a warning, ask the person before calling again with `confirm: true`.',
  'Writes take an optional `idempotency_key`; reuse it when retrying the same change.',
].join(' ');

export interface ToolCallLog {
  tool: string;
  kind: 'read' | 'write';
  ok: boolean;
  ms: number;
  /** An error class or code, never a message (messages may hold names). */
  error?: string;
}

export interface ServerOptions {
  /** Whether this call is within the connection's rate limits. */
  allow?: (kind: 'read' | 'write') => Promise<boolean>;
  /** Called once per tool call, with nothing personal in it. */
  log?: (entry: ToolCallLog) => void;
  /** The grant's Firebase sign-in is gone for good: end the grant. */
  onRevoked?: () => Promise<void>;
}

const errorCode = (e: unknown) =>
  e instanceof UserError ? `user:${e.key}` : e instanceof FirestoreError ? `firestore:${e.code}` : e instanceof FirebaseAuthError ? `auth:${e.kind}` : e instanceof Error ? e.name : 'unknown';

/** An MCP server for one request, its tools acting as `session`'s person. */
export function buildServer(session: Session, { allow, log, onRevoked }: ServerOptions = {}): McpServer {
  const server = new McpServer({ name: 'huishouden', title: 'Huishouden', version: '0.1.0' }, { instructions: INSTRUCTIONS, jsonSchemaValidator: new CfWorkerJsonSchemaValidator() });
  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.input,
        annotations: { title: tool.title, readOnlyHint: tool.kind === 'read', destructiveHint: false, idempotentHint: tool.kind === 'read', openWorldHint: false },
      },
      async (args: Record<string, unknown>) => {
        const started = Date.now();
        let lang: Lang = 'en';
        let householdId: string | undefined;
        let touched: Pick<AuditEntry, 'app' | 'ref'> = {};
        const finish = (ok: boolean, error?: unknown) => {
          if (householdId) session.record(householdId, { tool: tool.name, kind: tool.kind, ok, ...touched });
          log?.({ tool: tool.name, kind: tool.kind, ok, ms: Date.now() - started, ...(error !== undefined ? { error: errorCode(error) } : {}) });
        };
        try {
          lang = await session.lang(undefined, args.lang as string | undefined);
          if (allow && !(await allow(tool.kind))) {
            finish(false, new UserError('error.rateLimited'));
            return toMcp({ text: render(lang, () => t('error.rateLimited')), error: true }, lang);
          }
          const here = await session.here(args.household as string | undefined);
          householdId = here.id;
          lang = await session.lang(here.id, args.lang as string | undefined);
          const clock = await session.clock(here.id, args.time_zone as string | undefined);
          const result = await tool.run({ session, here, clock, lang, touched: (app, ref) => (touched = { app, ...(ref ? { ref } : {}) }) }, args as never);
          finish(!result.error);
          return toMcp(result, lang, tool.health);
        } catch (e) {
          finish(false, e);
          if (e instanceof FirebaseAuthError && e.kind === 'revoked') await onRevoked?.().catch(() => {});
          return toMcp({ text: failureText(e, lang), error: true }, lang, tool.health);
        }
      },
    );
  }
  return server;
}
