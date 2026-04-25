import { logger } from '../../utils/logger.js';
import { resolve } from 'path';
import { getProjectContext } from '../../utils/project-name.js';
import { resolveFieldSpec, resolveFields, matchesRule } from './field-utils.js';
import type {
  EventAction,
  TranscriptCanonicalAudit,
  TranscriptCanonicalEvent,
  TranscriptCanonicalSession,
  TranscriptCanonicalSource,
  TranscriptReplaySemantics,
  TranscriptSchema,
  WatchTarget,
  SchemaEvent
} from './types.js';
import { normalizePlatformSource } from '../../shared/platform-source.js';
import { parseSubagentNotifications } from '../../shared/transcript-parser.js';
import { resolveAgentsMdProjectionTarget } from '../../utils/agents-md-utils.js';
import { CANONICAL_EVENT_SCHEMA_VERSION } from '../codex-events/CanonicalEvent.js';
import { projectSubagentReceipts } from '../codex-events/SubagentReceiptProjector.js';

interface SessionState {
  sessionId: string;
  platformSource: string;
  cwd?: string;
  project?: string;
  lastUserMessage?: string;
  lastAssistantMessage?: string;
  pendingTools: Map<string, { name?: string; input?: unknown }>;
}

interface PendingTool {
  id?: string;
  name?: string;
  input?: unknown;
  response?: unknown;
}

const TRANSCRIPT_EVENT_METADATA = {
  sourceRail: 'transcript',
  railRole: 'fallback_replay_audit',
  canonicalPriority: 'secondary'
} as const;

const TRANSCRIPT_EVENT_SOURCE: TranscriptCanonicalSource = {
  rail: TRANSCRIPT_EVENT_METADATA.sourceRail,
  role: TRANSCRIPT_EVENT_METADATA.railRole,
  priority: TRANSCRIPT_EVENT_METADATA.canonicalPriority,
  primaryRail: 'hooks'
};

const TRANSCRIPT_REPLAY_SEMANTICS: TranscriptReplaySemantics = {
  mode: 'source_adapter',
  recovery: 'fill_missing_events_only',
  overwritePolicy: 'never_overwrite_hook_primary',
  lateArrivalPolicy: 'preserve_existing_order'
};

export class TranscriptEventProcessor {
  private sessions = new Map<string, SessionState>();

  async processEntry(
    entry: unknown,
    watch: WatchTarget,
    schema: TranscriptSchema,
    sessionIdOverride?: string | null
  ): Promise<TranscriptCanonicalEvent[]> {
    const canonicalEvents: TranscriptCanonicalEvent[] = [];
    for (const event of schema.events) {
      if (!matchesRule(entry, event.match, schema)) continue;
      canonicalEvents.push(...this.handleEvent(entry, watch, schema, event, sessionIdOverride ?? undefined));
    }
    return canonicalEvents;
  }

  private getSessionKey(watch: WatchTarget, sessionId: string): string {
    return `${watch.name}:${sessionId}`;
  }

  private getOrCreateSession(watch: WatchTarget, sessionId: string): SessionState {
    const key = this.getSessionKey(watch, sessionId);
    let session = this.sessions.get(key);
    if (!session) {
      session = {
        sessionId,
        platformSource: normalizePlatformSource(watch.name),
        pendingTools: new Map()
      };
      this.sessions.set(key, session);
    }
    return session;
  }

  private resolveSessionId(
    entry: unknown,
    watch: WatchTarget,
    schema: TranscriptSchema,
    event: SchemaEvent,
    sessionIdOverride?: string
  ): string | null {
    const ctx = { watch, schema } as any;
    const fieldSpec = event.fields?.sessionId ?? (schema.sessionIdPath ? { path: schema.sessionIdPath } : undefined);
    const resolved = resolveFieldSpec(fieldSpec, entry, ctx);
    if (typeof resolved === 'string' && resolved.trim()) return resolved;
    if (typeof resolved === 'number') return String(resolved);
    if (sessionIdOverride && sessionIdOverride.trim()) return sessionIdOverride;
    return null;
  }

  private resolveCwd(
    entry: unknown,
    watch: WatchTarget,
    schema: TranscriptSchema,
    event: SchemaEvent,
    session: SessionState
  ): string | undefined {
    const ctx = { watch, schema, session } as any;
    const fieldSpec = event.fields?.cwd ?? (schema.cwdPath ? { path: schema.cwdPath } : undefined);
    const resolved = resolveFieldSpec(fieldSpec, entry, ctx);
    if (typeof resolved === 'string' && resolved.trim()) return resolved;
    if (session.cwd) return session.cwd;
    if (watch.workspace) return watch.workspace;
    return undefined;
  }

  private resolveProject(
    entry: unknown,
    watch: WatchTarget,
    schema: TranscriptSchema,
    event: SchemaEvent,
    session: SessionState
  ): string | undefined {
    const ctx = { watch, schema, session } as any;
    const fieldSpec = event.fields?.project ?? (schema.projectPath ? { path: schema.projectPath } : undefined);
    const resolved = resolveFieldSpec(fieldSpec, entry, ctx);
    if (typeof resolved === 'string' && resolved.trim()) return resolved;
    if (watch.project) return watch.project;
    if (session.cwd) {
      const cwdContext = getProjectContext(session.cwd);
      if (!watch.workspace || (cwdContext.scopeRoot && resolve(cwdContext.scopeRoot) !== resolve(session.cwd))) {
        return cwdContext.primary;
      }
    }
    if (watch.workspace) return getProjectContext(watch.workspace).primary;
    if (session.cwd) return getProjectContext(session.cwd).primary;
    return session.project;
  }

  private handleEvent(
    entry: unknown,
    watch: WatchTarget,
    schema: TranscriptSchema,
    event: SchemaEvent,
    sessionIdOverride?: string
  ): TranscriptCanonicalEvent[] {
    const sessionId = this.resolveSessionId(entry, watch, schema, event, sessionIdOverride);
    if (!sessionId) {
      logger.debug('WORKER', 'Skipping transcript event without sessionId', { event: event.name, watch: watch.name });
      return [];
    }

    const session = this.getOrCreateSession(watch, sessionId);
    const cwd = this.resolveCwd(entry, watch, schema, event, session);
    if (cwd) session.cwd = cwd;
    const project = this.resolveProject(entry, watch, schema, event, session);
    if (project) session.project = project;

    const fields = resolveFields(event.fields, entry, { watch, schema, session: session as unknown as Record<string, unknown> });
    const canonicalEvents: TranscriptCanonicalEvent[] = [];
    const subagentReceiptEvents = this.handleSubagentNotification(watch, session, fields);
    if (subagentReceiptEvents.length > 0) {
      return subagentReceiptEvents;
    }

    switch (event.action) {
      case 'session_context': {
        this.applySessionContext(session, fields);
        canonicalEvents.push(this.createCanonicalEvent(watch, schema, event, session, 'session_context', {
          cwd: session.cwd,
          project: session.project
        }));
        break;
      }
      case 'session_init':
        canonicalEvents.push(this.handleSessionInit(watch, schema, event, session, fields));
        break;
      case 'user_message':
        if (typeof fields.message === 'string') session.lastUserMessage = fields.message;
        if (typeof fields.prompt === 'string') session.lastUserMessage = fields.prompt;
        canonicalEvents.push(this.createCanonicalEvent(watch, schema, event, session, 'user_message', {
          message: session.lastUserMessage
        }));
        break;
      case 'assistant_message':
        if (typeof fields.message === 'string') session.lastAssistantMessage = fields.message;
        canonicalEvents.push(this.createCanonicalEvent(watch, schema, event, session, 'assistant_message', {
          message: session.lastAssistantMessage
        }));
        break;
      case 'tool_use':
        canonicalEvents.push(...this.handleToolUse(watch, schema, event, session, fields));
        break;
      case 'tool_result':
        canonicalEvents.push(...this.handleToolResult(watch, schema, event, session, fields));
        break;
      case 'observation':
        canonicalEvents.push(this.createCanonicalEvent(watch, schema, event, session, 'observation', this.normalizeToolPayload(fields)));
        break;
      case 'file_edit':
        canonicalEvents.push(this.createFileEditEvent(watch, schema, event, session, fields));
        break;
      case 'session_end':
        canonicalEvents.push(this.handleSessionEnd(watch, schema, event, session));
        break;
      default:
        break;
    }

    return canonicalEvents;
  }

  private applySessionContext(session: SessionState, fields: Record<string, unknown>): void {
    const cwd = typeof fields.cwd === 'string' ? fields.cwd : undefined;
    const project = typeof fields.project === 'string' ? fields.project : undefined;
    if (cwd) session.cwd = cwd;
    if (project) session.project = project;
  }

  private handleSubagentNotification(
    watch: WatchTarget,
    session: SessionState,
    fields: Record<string, unknown>
  ): TranscriptCanonicalEvent[] {
    const message = typeof fields.message === 'string' ? fields.message : undefined;
    if (!message) return [];

    const receipts = parseSubagentNotifications(message);
    if (receipts.length === 0) return [];

    const parentSession = {
      id: session.sessionId,
      platformSource: session.platformSource,
      cwd: session.cwd,
      project: session.project,
      transcriptPath: watch.path
    };
    return projectSubagentReceipts({ parentSession, receipts }) as unknown as TranscriptCanonicalEvent[];
  }

  private handleSessionInit(
    watch: WatchTarget,
    schema: TranscriptSchema,
    event: SchemaEvent,
    session: SessionState,
    fields: Record<string, unknown>
  ): TranscriptCanonicalEvent {
    const prompt = typeof fields.prompt === 'string' ? fields.prompt : '';
    if (prompt) {
      session.lastUserMessage = prompt;
    }

    const contextProjection = this.createContextProjection(watch, session, 'session_start');
    return this.createCanonicalEvent(watch, schema, event, session, 'session_init', {
      prompt,
      contextUpdateRequested: Boolean(contextProjection),
      contextProjection
    });
  }

  private handleToolUse(
    watch: WatchTarget,
    schema: TranscriptSchema,
    event: SchemaEvent,
    session: SessionState,
    fields: Record<string, unknown>
  ): TranscriptCanonicalEvent[] {
    const toolId = typeof fields.toolId === 'string' ? fields.toolId : undefined;
    const toolName = typeof fields.toolName === 'string' ? fields.toolName : undefined;
    const toolInput = this.maybeParseJson(fields.toolInput);
    const toolResponse = this.maybeParseJson(fields.toolResponse);

    const pending: PendingTool = { id: toolId, name: toolName, input: toolInput, response: toolResponse };
    const canonicalEvents: TranscriptCanonicalEvent[] = [
      this.createCanonicalEvent(watch, schema, event, session, 'tool_use', this.normalizeToolPayload({
        toolId,
        toolName,
        toolInput,
        toolResponse
      }))
    ];

    if (toolId) {
      session.pendingTools.set(toolId, { name: pending.name, input: pending.input });
    }

    if (toolName === 'apply_patch' && typeof toolInput === 'string') {
      const files = this.parseApplyPatchFiles(toolInput);
      for (const filePath of files) {
        canonicalEvents.push(this.createFileEditEvent(watch, schema, event, session, {
          toolId,
          toolName,
          filePath,
          edits: [{ type: 'apply_patch', patch: toolInput }]
        }));
      }
    }

    if (toolResponse !== undefined && toolName) {
      canonicalEvents.push(this.createCanonicalEvent(watch, schema, event, session, 'observation', this.normalizeToolPayload({
        toolName,
        toolInput,
        toolResponse
      })));
    }

    return canonicalEvents;
  }

  private handleToolResult(
    watch: WatchTarget,
    schema: TranscriptSchema,
    event: SchemaEvent,
    session: SessionState,
    fields: Record<string, unknown>
  ): TranscriptCanonicalEvent[] {
    const toolId = typeof fields.toolId === 'string' ? fields.toolId : undefined;
    const toolName = typeof fields.toolName === 'string' ? fields.toolName : undefined;
    const toolResponse = this.maybeParseJson(fields.toolResponse);

    let toolInput: unknown = this.maybeParseJson(fields.toolInput);
    let name = toolName;

    if (toolId && session.pendingTools.has(toolId)) {
      const pending = session.pendingTools.get(toolId)!;
      toolInput = pending.input ?? toolInput;
      name = name ?? pending.name;
      session.pendingTools.delete(toolId);
    }

    if (!name) return [];

    return [
      this.createCanonicalEvent(watch, schema, event, session, 'tool_result', this.normalizeToolPayload({
        toolId,
        toolName: name,
        toolInput,
        toolResponse
      }))
    ];
  }

  private normalizeToolPayload(fields: Record<string, unknown>): Record<string, unknown> {
    return {
      ...fields,
      toolInput: this.maybeParseJson(fields.toolInput),
      toolResponse: this.maybeParseJson(fields.toolResponse)
    };
  }

  private createFileEditEvent(
    watch: WatchTarget,
    schema: TranscriptSchema,
    event: SchemaEvent,
    session: SessionState,
    fields: Record<string, unknown>
  ): TranscriptCanonicalEvent {
    const filePath = typeof fields.filePath === 'string' ? fields.filePath : undefined;
    return this.createCanonicalEvent(watch, schema, event, session, 'file_edit', {
      toolId: fields.toolId,
      toolName: fields.toolName,
      filePath,
      edits: Array.isArray(fields.edits) ? fields.edits : undefined
    });
  }

  private maybeParseJson(value: unknown): unknown {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    if (!trimmed) return value;
    if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return value;
    try {
      return JSON.parse(trimmed);
    } catch (error: unknown) {
      logger.debug('WORKER', 'Failed to parse JSON string', { length: trimmed.length }, error instanceof Error ? error : undefined);
      return value;
    }
  }

  private parseApplyPatchFiles(patch: string): string[] {
    const files: string[] = [];
    const lines = patch.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('*** Update File: ')) {
        files.push(trimmed.replace('*** Update File: ', '').trim());
      } else if (trimmed.startsWith('*** Add File: ')) {
        files.push(trimmed.replace('*** Add File: ', '').trim());
      } else if (trimmed.startsWith('*** Delete File: ')) {
        files.push(trimmed.replace('*** Delete File: ', '').trim());
      } else if (trimmed.startsWith('*** Move to: ')) {
        files.push(trimmed.replace('*** Move to: ', '').trim());
      } else if (trimmed.startsWith('+++ ')) {
        const path = trimmed.replace('+++ ', '').replace(/^b\//, '').trim();
        if (path && path !== '/dev/null') files.push(path);
      }
    }
    return Array.from(new Set(files));
  }

  private handleSessionEnd(
    watch: WatchTarget,
    schema: TranscriptSchema,
    event: SchemaEvent,
    session: SessionState
  ): TranscriptCanonicalEvent {
    const contextProjection = this.createContextProjection(watch, session, 'session_end');
    const canonicalEvent = this.createCanonicalEvent(watch, schema, event, session, 'session_end', {
      lastAssistantMessage: session.lastAssistantMessage ?? '',
      contextUpdateRequested: Boolean(contextProjection),
      contextProjection
    });
    session.pendingTools.clear();
    const key = this.getSessionKey(watch, session.sessionId);
    this.sessions.delete(key);
    return canonicalEvent;
  }

  private createContextProjection(
    watch: WatchTarget,
    session: SessionState,
    trigger: 'session_start' | 'session_end'
  ): Record<string, unknown> | undefined {
    if (watch.context?.mode !== 'agents') return undefined;
    if (watch.context.updateOn?.includes(trigger) !== true) return undefined;

    const target = resolveAgentsMdProjectionTarget({
      contextPath: watch.context.path,
      workspace: watch.workspace,
      cwd: session.cwd
    });
    if (!target) return undefined;

    const projection: Record<string, unknown> = {
      mode: 'agents',
      role: 'projection_sink_not_storage',
      trigger,
      targetPath: target.targetPath,
      targetScope: target.targetScope,
      precedence: target.precedence,
      codexScopeNote: 'root/nested AGENTS accumulate; same-directory AGENTS.override.md masks AGENTS.md'
    };

    if (watch.workspace && session.cwd && resolve(watch.workspace) !== resolve(session.cwd)) {
      projection.cwdDrift = {
        workspace: watch.workspace,
        observedCwd: session.cwd,
        status: target.cwdDriftStatus
      };
    }

    return projection;
  }

  private createCanonicalEvent(
    watch: WatchTarget,
    schema: TranscriptSchema,
    event: SchemaEvent,
    session: SessionState,
    type: EventAction,
    payload: Record<string, unknown>
  ): TranscriptCanonicalEvent {
    const cleanedPayload = this.dropUndefined(payload);
    const idempotencyKey = this.createIdempotencyKey(watch, session, type, cleanedPayload);
    const canonicalSession: TranscriptCanonicalSession = {
      id: session.sessionId,
      platformSource: session.platformSource
    };
    if (session.cwd) canonicalSession.cwd = session.cwd;
    if (session.project) canonicalSession.project = session.project;

    const audit: TranscriptCanonicalAudit = {
      watchName: watch.name,
      schemaName: schema.name,
      eventName: event.name,
      observedAt: new Date().toISOString()
    };
    if (schema.version) audit.schemaVersion = schema.version;

    return {
      schemaVersion: CANONICAL_EVENT_SCHEMA_VERSION,
      id: idempotencyKey,
      idempotencyKey,
      type,
      materialization: 'deferred',
      source: this.createTranscriptSource(watch),
      replay: TRANSCRIPT_REPLAY_SEMANTICS,
      session: canonicalSession,
      payload: cleanedPayload,
      observedAt: audit.observedAt,
      audit,
      metadata: {
        observedFrom: 'transcript-jsonl',
        replayRole: TRANSCRIPT_EVENT_METADATA.railRole,
        watchName: watch.name,
        schemaName: schema.name,
        schemaEventName: event.name
      }
    };
  }

  private createTranscriptSource(watch: WatchTarget): TranscriptCanonicalSource {
    return {
      ...TRANSCRIPT_EVENT_SOURCE,
      adapter: `${watch.name}-transcript`
    };
  }

  private createIdempotencyKey(
    watch: WatchTarget,
    session: SessionState,
    type: EventAction,
    payload: Record<string, unknown>
  ): string {
    const base = `${watch.name}:${session.sessionId}:${type}`;
    const toolId = typeof payload.toolId === 'string' ? payload.toolId : undefined;
    const filePath = typeof payload.filePath === 'string' ? payload.filePath : undefined;
    if (type === 'file_edit' && filePath) {
      return toolId ? `${base}:${filePath}:${toolId}` : `${base}:${filePath}`;
    }
    if (toolId) return `${base}:${toolId}`;
    return base;
  }

  private dropUndefined<T extends Record<string, unknown>>(input: T): Record<string, unknown> {
    const output: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
      if (value !== undefined) output[key] = value;
    }
    return output;
  }
}
