import { describe, expect, it } from 'bun:test';
import {
  CANONICAL_EVENT_ENVELOPE_FIELDS,
  CANONICAL_EVENT_SCHEMA_VERSION,
  CANONICAL_EVENT_TYPES,
  defineCanonicalEvent,
  isCanonicalEventType,
} from '../../../src/services/codex-events/CanonicalEvent.js';
import {
  CANONICAL_TRANSCRIPT_REPLAY_DEFAULTS,
  createTranscriptReplayMetadata,
  withReplayDefaults,
} from '../../../src/services/codex-events/EventReplay.js';
import { CONTEXT_CANONICAL_EVENT_FIELDS } from '../../../src/services/context/types.js';

describe('canonical Codex event schema', () => {
  it('defines a stable envelope for hook-primary and transcript-secondary events', () => {
    const event = defineCanonicalEvent({
      idempotencyKey: 'codex:session-1:tool_result:call-1',
      type: 'tool_result',
      source: {
        rail: 'transcript',
        role: 'fallback_replay_audit',
        priority: 'secondary',
        primaryRail: 'hooks',
      },
      session: {
        id: 'session-1',
        cwd: '/repo',
        project: 'repo',
        platformSource: 'codex',
      },
      materialization: 'deferred',
      payload: {
        toolId: 'call-1',
        toolName: 'apply_patch',
        toolResponse: { exitCode: 0 },
      },
      replay: createTranscriptReplayMetadata(),
      metadata: {
        observedFrom: 'transcript-jsonl',
      },
    });

    expect(event.schemaVersion).toBe(CANONICAL_EVENT_SCHEMA_VERSION);
    expect(event.idempotencyKey).toBe('codex:session-1:tool_result:call-1');
    expect(event.source).toEqual({
      rail: 'transcript',
      role: 'fallback_replay_audit',
      priority: 'secondary',
      primaryRail: 'hooks',
    });
    expect(event.session).toEqual({
      id: 'session-1',
      cwd: '/repo',
      project: 'repo',
      platformSource: 'codex',
    });
    expect(event.payload).toEqual({
      toolId: 'call-1',
      toolName: 'apply_patch',
      toolResponse: { exitCode: 0 },
    });

    // Worker 1 owns schema only: no ordering/sequence policy should be invented here.
    expect('sequence' in event).toBe(false);
    expect('orderIndex' in event).toBe(false);
    expect('sortKey' in event).toBe(false);
  });

  it('reserves child and compact event types without implementing Phase 4 behavior', () => {
    expect(CANONICAL_EVENT_TYPES).toContain('child_session');
    expect(CANONICAL_EVENT_TYPES).toContain('compact_summary');
    expect(isCanonicalEventType('child_session')).toBe(true);
    expect(isCanonicalEventType('compact_summary')).toBe(true);
    expect(isCanonicalEventType('ordering_policy')).toBe(false);

    const childReceipt = defineCanonicalEvent({
      idempotencyKey: 'codex:parent-session:child_session:child-session',
      type: 'child_session',
      source: {
        rail: 'child',
        role: 'child_receipt',
        priority: 'sidecar',
        primaryRail: 'hooks',
      },
      session: {
        id: 'parent-session',
        parentSessionId: 'root-session',
        platformSource: 'codex',
      },
      materialization: 'deferred',
      payload: {
        childSessionId: 'child-session',
        agentId: 'worker-1',
        agentType: 'schema-worker',
        status: 'reported',
      },
    });

    expect(childReceipt.payload).toEqual({
      childSessionId: 'child-session',
      agentId: 'worker-1',
      agentType: 'schema-worker',
      status: 'reported',
    });
  });

  it('keeps replay metadata as a recovery contract, not an ordering implementation', () => {
    expect(CANONICAL_TRANSCRIPT_REPLAY_DEFAULTS).toEqual({
      mode: 'source_adapter',
      recovery: 'fill_missing_events_only',
      overwritePolicy: 'never_overwrite_hook_primary',
      lateArrivalPolicy: 'preserve_existing_order',
    });

    const event = withReplayDefaults(defineCanonicalEvent({
      idempotencyKey: 'codex:session-2:session_init',
      type: 'session_init',
      source: {
        rail: 'transcript',
        role: 'fallback_replay_audit',
        priority: 'secondary',
        primaryRail: 'hooks',
      },
      session: {
        id: 'session-2',
        platformSource: 'codex',
      },
      materialization: 'deferred',
      payload: { prompt: 'hello' },
    }));

    expect(event.replay).toEqual(CANONICAL_TRANSCRIPT_REPLAY_DEFAULTS);
    expect(event.materialization).toBe('deferred');
    expect(Object.keys(event.replay ?? {})).not.toContain('sequence');
    expect(Object.keys(event.replay ?? {})).not.toContain('sortKey');
  });

  it('exposes context input hook points for canonical event bus metadata', () => {
    expect(CONTEXT_CANONICAL_EVENT_FIELDS).toEqual([
      'canonicalEvent',
      'canonicalSource',
      'canonicalReplay',
    ]);
  });

  it('publishes the canonical envelope field receipt without ordering-owned fields', () => {
    expect(CANONICAL_EVENT_ENVELOPE_FIELDS).toEqual([
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
    ]);
    expect(CANONICAL_EVENT_ENVELOPE_FIELDS).not.toContain('sequence');
    expect(CANONICAL_EVENT_ENVELOPE_FIELDS).not.toContain('orderIndex');
    expect(CANONICAL_EVENT_ENVELOPE_FIELDS).not.toContain('sortKey');
  });
});
