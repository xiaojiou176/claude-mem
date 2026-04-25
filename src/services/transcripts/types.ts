export type FieldSpec =
  | string
  | {
      path?: string;
      value?: unknown;
      coalesce?: FieldSpec[];
      default?: unknown;
    };

export interface MatchRule {
  path?: string;
  equals?: unknown;
  in?: unknown[];
  contains?: string;
  exists?: boolean;
  regex?: string;
}

export type EventAction =
  | 'session_init'
  | 'session_context'
  | 'user_message'
  | 'assistant_message'
  | 'tool_use'
  | 'tool_result'
  | 'observation'
  | 'file_edit'
  | 'session_end';

export type TranscriptCanonicalPriority = 'secondary';
export type TranscriptCanonicalRailRole = 'fallback_replay_audit';
export type TranscriptMaterializationMode = 'deferred';
export type TranscriptReplayMode = 'source_adapter';
export type TranscriptCanonicalSchemaVersion = 'codex-event/v1';

export interface TranscriptCanonicalSource {
  rail: 'transcript';
  role: TranscriptCanonicalRailRole;
  priority: TranscriptCanonicalPriority;
  primaryRail: 'hooks';
  adapter?: string;
}

export interface TranscriptReplaySemantics {
  mode: TranscriptReplayMode;
  recovery: 'fill_missing_events_only';
  overwritePolicy: 'never_overwrite_hook_primary';
  lateArrivalPolicy: 'preserve_existing_order';
}

export interface TranscriptCanonicalSession {
  id: string;
  platformSource: string;
  cwd?: string;
  project?: string;
}

export interface TranscriptCanonicalAudit {
  watchName: string;
  schemaName: string;
  schemaVersion?: string;
  eventName: string;
  observedAt: string;
}

export interface TranscriptCanonicalEvent {
  schemaVersion: TranscriptCanonicalSchemaVersion;
  id: string;
  idempotencyKey: string;
  type: EventAction;
  materialization: TranscriptMaterializationMode;
  source: TranscriptCanonicalSource;
  replay: TranscriptReplaySemantics;
  session: TranscriptCanonicalSession;
  payload: Record<string, unknown>;
  observedAt: string;
  audit: TranscriptCanonicalAudit;
  metadata: Record<string, unknown>;
}

export interface SchemaEvent {
  name: string;
  match?: MatchRule;
  action: EventAction;
  fields?: Record<string, FieldSpec>;
}

export interface TranscriptSchema {
  name: string;
  version?: string;
  description?: string;
  eventTypePath?: string;
  sessionIdPath?: string;
  cwdPath?: string;
  projectPath?: string;
  events: SchemaEvent[];
}

export interface WatchContextConfig {
  mode: 'agents';
  path?: string;
  updateOn?: Array<'session_start' | 'session_end'>;
}

export interface WatchTarget {
  name: string;
  path: string;
  schema: string | TranscriptSchema;
  workspace?: string;
  project?: string;
  context?: WatchContextConfig;
  rescanIntervalMs?: number;
  startAtEnd?: boolean;
}

export interface TranscriptWatchConfig {
  version: 1;
  schemas?: Record<string, TranscriptSchema>;
  watches: WatchTarget[];
  stateFile?: string;
}
