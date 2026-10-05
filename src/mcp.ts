import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker-provider.js';
import { errorCode, runTool, signInEnded, TOOLS, type Session, type ToolCall, type ToolResult } from '@huishouden/pwa-kit/household-tools';
import { FirestoreError } from '@huishouden/pwa-kit/firestore-rest';
import { isLang, loadLang, withLang, type Lang } from '@huishouden/pwa-kit/i18n';
import { t } from './i18n';
import { nextPacificMidnight, type QuotaScope, type ReadMeter } from './reads';

export { TOOLS };

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
  /** Firestore reads the call was billed for (src/reads.ts). */
  reads?: number;
}

export interface ServerOptions {
  /** Whether this call is within the connection's rate limits. */
  allow?: (kind: 'read' | 'write') => Promise<boolean>;
  /** Called once per tool call, with nothing personal in it. */
  log?: (entry: ToolCallLog) => void;
  /** The grant's Firebase sign-in is gone for good: end the grant. */
  onRevoked?: () => Promise<void>;
  /** The day's Firestore read budgets; the session's FirestoreRest fetches through `reads.fetch`. */
  reads?: ReadMeter;
  /** Work that may finish after the answer (the Worker's `ctx.waitUntil`); awaited when unset. */
  defer?: (work: Promise<void>) => void;
}

/** Firestore said the project's daily quota is used up (429 RESOURCE_EXHAUSTED; Spark resets at midnight Pacific). */
export const overQuota = (e: unknown): boolean => e instanceof FirestoreError && /\b429\b|RESOURCE_EXHAUSTED/.test(e.message);

/**
 * A call refused for reads: `firestore-quota`, as calendar's API answers, with which budget and when
 * it resets. The text says so in the person's language rather than "could not be reached".
 */
export async function quotaResult(scope: QuotaScope, lang: Lang, now: number): Promise<ToolResult> {
  await loadLang(lang);
  return {
    text: withLang(lang, () => t(`quota.${scope}`)),
    data: { error: 'firestore-quota', scope, resetsAt: new Date(nextPacificMidnight(now)).toISOString() },
    error: true,
  };
}

/** The MCP result for a tool's answer. */
export function toMcp(result: ToolResult) {
  return {
    content: [{ type: 'text' as const, text: result.text }],
    ...(result.data ? { structuredContent: result.data } : {}),
    ...(result.error ? { isError: true } : {}),
  };
}

/** An MCP server for one request, its tools acting as `session`'s person. */
export function buildServer(session: Session, { allow, log, onRevoked, reads, defer }: ServerOptions = {}): McpServer {
  let turn: Promise<void> = Promise.resolve();
  const callTool = async (tool: (typeof TOOLS)[number], args: Record<string, unknown>) => {
    const started = Date.now();
    let call: ToolCall | undefined;
    let scope: QuotaScope | null = null;
    let billed: number | undefined;
    try {
      const spent = reads ? await reads.begin() : null;
      // The tools themselves are @huishouden/pwa-kit/household-tools, shared with `hh data`.
      call = spent
        ? { result: { text: '', error: true }, lang: requestLang(session, args), touched: {} }
        : await runTool(session, tool, args, { allow });
      scope = spent ?? reads?.refused ?? (overQuota(call.error) ? 'project' : null);
      // A budget met mid-call refuses every read after it (and any write), and a tool may answer
      // around a failed read: the whole answer is the quota's, never a partial one. A change saved
      // before that keeps its own answer, so the assistant doesn't make it again.
      if (scope && !(reads?.wrote && !call.result.error)) call.result = await quotaResult(scope, call.lang, (reads?.now ?? Date.now)());
    } finally {
      billed = reads?.reads;
      if (reads) {
        const done = reads.finish();
        if (defer) defer(done);
        else await done;
      }
      const error = scope ? 'firestore-quota' : !call ? 'thrown' : call.error !== undefined ? errorCode(call.error) : undefined;
      log?.({ tool: tool.name, kind: tool.kind, ok: !!call && !call.result.error, ms: Date.now() - started, ...(error ? { error } : {}), ...(billed !== undefined ? { reads: billed } : {}) });
    }
    if (call.householdId) session.record(call.householdId, { tool: tool.name, kind: tool.kind, ok: !call.result.error, ...call.touched });
    if (signInEnded(call.error)) await onRevoked?.().catch(() => {});
    return toMcp(call.result);
  };
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
      // One call at a time per request: the meter's counts are the call's (a JSON-RPC batch would
      // otherwise run its calls at once on one meter).
      (args: Record<string, unknown>) => {
        const run = turn.then(() => callTool(tool, args));
        turn = run.then(() => undefined, () => undefined);
        return run;
      },
    );
  }
  return server;
}

/** The language for an answer given before any read: the call's `lang`, the grant's, else English. */
const requestLang = (session: Session, args: Record<string, unknown>): Lang =>
  isLang(args.lang) ? args.lang : session.props.lang ?? 'en';
