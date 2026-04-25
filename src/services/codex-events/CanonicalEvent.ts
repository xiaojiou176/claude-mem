/**
 * Canonical Codex event schema.
 *
 * Phase 2 Worker 1 owns the stable event envelope only. Identity generation,
 * source priority, ordering, stitching, and transcript materialization remain
 * owned by later workers.
 */

export const CANONICAL_EVENT_SCHEMA_VERSION = 'codex-event/v1' as const;

export const CANONICAL_EVENT_ENVELOPE_FIELDS = [
  'schemaVersion',
  'idempotencyKey',
  'type',
  'source',
  'session',
  'materialization',
  'payload',
  'observedAt',
  'replay',
  'links',
  'metadata',
] as const;

export const CANONICAL_EVENT_TYPES = [
  'session_context',
  'session_init',
  'user_message',
  'assistant_message',
  'tool_use',
  'tool_result',
  'observation',
  'file_edit',
  'session_end',
  'child_session',
  'compact_summary',
] as const;

export type CanonicalEventType = typeof CANONICAL_EVENT_TYPES[number];

export type CanonicalEventRail =
  | 'hooks'
  | 'transcript'
  | 'child'
  | 'compact';

export type CanonicalEventSourceRole =
  | 'primary'
  | 'fallback_replay_audit'
  | 'child_receipt'
  | 'compact_receipt';

export type CanonicalEventPriority =
  | 'primary'
  | 'secondary'
  | 'sidecar';

export interface CanonicalEventSource {
  /** Physical or logical rail where the event was observed. */
  rail: CanonicalEventRail;
  /** Role of this rail in Phase 2 truth layering. */
  role: CanonicalEventSourceRole;
  /** Priority label only; ordering/stitching policy is owned elsewhere. */
  priority: CanonicalEventPriority;
  /** Usually hooks for Codex hook-first ingestion. */
  primaryRail?: CanonicalEventRail;
  /** Optional source adapter or watcher name. */
  adapter?: string;
}

export interface CanonicalEventSession {
  id: string;
  platformSource: string;
  cwd?: string;
  project?: string;
  transcriptPath?: string;
  parentSessionId?: string;
  turnId?: string;
}

export type CanonicalMaterialization =
  | 'immediate'
  | 'deferred'
  | 'skipped';

export type CanonicalReplayMode =
  | 'source_adapter'
  | 'audit_only';

export type CanonicalReplayRecovery =
  | 'fill_missing_events_only'
  | 'audit_without_materialization';

export type CanonicalReplayOverwritePolicy =
  | 'never_overwrite_hook_primary';

export type CanonicalReplayLateArrivalPolicy =
  | 'preserve_existing_order';

export interface CanonicalReplayMetadata {
  mode: CanonicalReplayMode;
  recovery: CanonicalReplayRecovery;
  overwritePolicy: CanonicalReplayOverwritePolicy;
  lateArrivalPolicy: CanonicalReplayLateArrivalPolicy;
}

export interface SessionContextPayload {
  cwd?: string;
  project?: string;
  transcriptPath?: string;
}

export interface SessionInitPayload {
  prompt: string;
}

export interface MessagePayload {
  message: string;
}

export interface ToolUsePayload {
  toolId?: string;
  toolName?: string;
  toolInput?: unknown;
}

export interface ToolResultPayload extends ToolUsePayload {
  toolResponse?: unknown;
}

export interface ObservationPayload extends ToolResultPayload {
  toolName: string;
}

export interface FileEditPayload {
  filePath: string;
  edits?: unknown[];
  toolId?: string;
  toolName?: string;
  toolInput?: unknown;
  toolResponse?: unknown;
}

export interface SessionEndPayload {
  reason?: string;
  lastAssistantMessage?: string;
}

export interface ChildSessionPayload {
  childSessionId?: string;
  parentEventId?: string;
  agentId?: string;
  agentType?: string;
  status?: 'started' | 'reported' | 'completed' | 'failed';
}

export interface CompactSummaryPayload {
  trigger?: 'manual' | 'auto' | 'unknown';
  summary?: string;
  sourceRange?: {
    fromEventId?: string;
    toEventId?: string;
  };
}

export type CanonicalEventPayloadByType = {
  session_context: SessionContextPayload;
  session_init: SessionInitPayload;
  user_message: MessagePayload;
  assistant_message: MessagePayload;
  tool_use: ToolUsePayload;
  tool_result: ToolResultPayload;
  observation: ObservationPayload;
  file_edit: FileEditPayload;
  session_end: SessionEndPayload;
  child_session: ChildSessionPayload;
  compact_summary: CompactSummaryPayload;
};

export interface CanonicalEventLinks {
  parentEventId?: string;
  childEventIds?: string[];
  relatedTranscriptOffset?: number;
}

export type CanonicalEventInput<TType extends CanonicalEventType = CanonicalEventType> = {
  idempotencyKey: string;
  type: TType;
  source: CanonicalEventSource;
  session: CanonicalEventSession;
  materialization: CanonicalMaterialization;
  payload: CanonicalEventPayloadByType[TType];
  observedAt?: string;
  replay?: CanonicalReplayMetadata;
  links?: CanonicalEventLinks;
  metadata?: Record<string, unknown>;
};

export type CanonicalEvent<TType extends CanonicalEventType = CanonicalEventType> =
  CanonicalEventInput<TType> & {
    schemaVersion: typeof CANONICAL_EVENT_SCHEMA_VERSION;
  };

export function isCanonicalEventType(value: string): value is CanonicalEventType {
  return (CANONICAL_EVENT_TYPES as readonly string[]).includes(value);
}

export function defineCanonicalEvent<TType extends CanonicalEventType>(
  event: CanonicalEventInput<TType>
): CanonicalEvent<TType> {
  return {
    schemaVersion: CANONICAL_EVENT_SCHEMA_VERSION,
    ...event,
  };
}
