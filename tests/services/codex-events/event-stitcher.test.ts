import { describe, expect, it } from 'bun:test';

import {
  EventStitcher,
  stitchCanonicalEvents,
} from '../../../src/services/codex-events/EventStitcher.js';
import type { StitchableEvent } from '../../../src/services/codex-events/EventIdentity.js';

function hookEvent(overrides: Partial<StitchableEvent>): StitchableEvent {
  return {
    type: 'tool_result',
    session: { id: 'session-1', platformSource: 'codex' },
    payload: {
      toolId: 'call-1',
      toolName: 'apply_patch',
      toolResponse: { exitCode: 0 },
    },
    source: { rail: 'hook', role: 'primary', priority: 'primary' },
    ...overrides,
  };
}

function transcriptEvent(overrides: Partial<StitchableEvent>): StitchableEvent {
  return {
    type: 'tool_result',
    session: { id: 'session-1', platformSource: 'codex' },
    payload: {
      toolId: 'call-1',
      toolName: 'apply_patch',
      toolResponse: { exitCode: 1, stderr: 'late transcript should not win' },
    },
    source: {
      rail: 'transcript',
      role: 'fallback_replay_audit',
      priority: 'secondary',
    },
    replay: {
      lateArrivalPolicy: 'preserve_existing_order',
      overwritePolicy: 'never_overwrite_hook_primary',
    },
    ...overrides,
  };
}

describe('EventStitcher', () => {
  it('dedupes hook and transcript observations while preserving hook truth', () => {
    const stitched = stitchCanonicalEvents([
      hookEvent({ observedAt: 100 }),
      transcriptEvent({ observedAt: 200 }),
    ]);

    expect(stitched.events).toHaveLength(1);
    expect(stitched.events[0]).toEqual(
      expect.objectContaining({
        source: expect.objectContaining({ rail: 'hook' }),
        payload: expect.objectContaining({
          toolId: 'call-1',
          toolName: 'apply_patch',
          toolResponse: { exitCode: 0 },
        }),
      }),
    );
    expect(stitched.duplicates).toEqual([
      expect.objectContaining({
        identity: 'codex:session-1:tool_result:call-1',
        keptRail: 'hook',
        droppedRail: 'transcript',
        reason: 'lower_priority_filled_gaps_only',
      }),
    ]);
  });

  it('lets transcript fill missing payload gaps without taking ownership from hook', () => {
    const stitched = stitchCanonicalEvents([
      hookEvent({
        payload: {
          toolId: 'call-1',
          toolName: 'apply_patch',
        },
      }),
      transcriptEvent({
        payload: {
          toolId: 'call-1',
          toolName: 'apply_patch',
          toolInput: '*** Begin Patch',
          toolResponse: { exitCode: 0, stdout: 'ok' },
        },
      }),
    ]);

    expect(stitched.events).toHaveLength(1);
    expect(stitched.events[0]).toEqual(
      expect.objectContaining({
        source: expect.objectContaining({ rail: 'hook' }),
        payload: expect.objectContaining({
          toolId: 'call-1',
          toolName: 'apply_patch',
          toolInput: '*** Begin Patch',
          toolResponse: { exitCode: 0, stdout: 'ok' },
        }),
      }),
    );
  });

  it('does not let late transcript reorder already accepted hook events', () => {
    const stitcher = new EventStitcher();

    stitcher.addMany([
      hookEvent({
        type: 'session_init',
        payload: { prompt: 'start' },
        idempotencyKey: 'codex:session-1:session_init',
        observedAt: 100,
      }),
      hookEvent({
        type: 'tool_result',
        payload: { toolId: 'call-1', toolName: 'Read' },
        observedAt: 200,
      }),
    ]);
    stitcher.add(
      transcriptEvent({
        type: 'file_edit',
        idempotencyKey: 'codex:session-1:file_edit:src/late.ts:call-0',
        payload: { filePath: 'src/late.ts', toolId: 'call-0', toolName: 'apply_patch' },
        observedAt: 50,
      }),
    );

    expect(stitcher.getEvents().map(event => event.idempotencyKey)).toEqual([
      'codex:session-1:session_init',
      'codex:session-1:tool_result:call-1',
      'codex:session-1:file_edit:src/late.ts:call-0',
    ]);
  });

  it('replaces earlier transcript backfill when the matching hook truth arrives later', () => {
    const stitched = stitchCanonicalEvents([
      transcriptEvent({
        observedAt: 100,
        payload: {
          toolId: 'call-1',
          toolName: 'apply_patch',
          toolInput: '*** Begin Patch',
          toolResponse: { exitCode: 1, stderr: 'transcript fallback' },
        },
      }),
      hookEvent({
        observedAt: 200,
        payload: {
          toolId: 'call-1',
          toolName: 'apply_patch',
          toolResponse: { exitCode: 0 },
        },
      }),
    ]);

    expect(stitched.events).toHaveLength(1);
    expect(stitched.events[0]).toEqual(
      expect.objectContaining({
        source: expect.objectContaining({ rail: 'hook' }),
        payload: expect.objectContaining({
          toolId: 'call-1',
          toolName: 'apply_patch',
          toolInput: '*** Begin Patch',
          toolResponse: { exitCode: 0 },
        }),
      }),
    );
    expect(stitched.duplicates).toEqual([
      expect.objectContaining({
        identity: 'codex:session-1:tool_result:call-1',
        keptRail: 'hook',
        droppedRail: 'transcript',
        reason: 'higher_priority_replaced_existing',
      }),
    ]);
  });
});
