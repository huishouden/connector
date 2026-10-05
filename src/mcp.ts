import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker-provider.js';
import { errorCode, runTool, signInEnded, TOOLS, type Session, type ToolResult } from '@huishouden/pwa-kit/household-tools';

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
}

export interface ServerOptions {
  /** Whether this call is within the connection's rate limits. */
  allow?: (kind: 'read' | 'write') => Promise<boolean>;
  /** Called once per tool call, with nothing personal in it. */
  log?: (entry: ToolCallLog) => void;
  /** The grant's Firebase sign-in is gone for good: end the grant. */
  onRevoked?: () => Promise<void>;
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
        // The tools themselves are @huishouden/pwa-kit/household-tools, shared with `hh data`.
        const call = await runTool(session, tool, args, { allow });
        if (call.householdId) session.record(call.householdId, { tool: tool.name, kind: tool.kind, ok: !call.result.error, ...call.touched });
        log?.({ tool: tool.name, kind: tool.kind, ok: !call.result.error, ms: Date.now() - started, ...(call.error !== undefined ? { error: errorCode(call.error) } : {}) });
        if (signInEnded(call.error)) await onRevoked?.().catch(() => {});
        return toMcp(call.result);
      },
    );
  }
  return server;
}
