import { describe, expect, it } from 'bun:test';

import {
  buildCompactAfterContinuationSpine,
  buildCompactContinuationEvent,
  classifyCompactRail,
} from '../../../src/services/codex-events/CompactContinuationBuilder.js';
import { extractDurableCompactRail } from '../../../src/services/context/ObservationCompiler.js';
import type { Observation } from '../../../src/services/context/types.js';

function observation(overrides: Partial<Observation>): Observation {
  return {
    id: 1,
    memory_session_id: 'session-1',
    platform_source: 'codex',
    type: 'decision',
    title: 'ContextCompaction durable receipt',
    subtitle: null,
    narrative: 'Compact summary saved into durable rail.',
    facts: JSON.stringify({
      durableRail: 'ThreadItem::ContextCompaction',
      summary: 'Recovered summary from durable compact rail.',
    }),
    concepts: JSON.stringify(['ContextCompaction', 'compact-aware-continuation']),
    files_read: null,
    files_modified: null,
    discovery_tokens: 0,
    created_at: '2026-04-24T16:00:00.000Z',
    created_at_epoch: 1777046400000,
    ...overrides,
  };
}

describe('CompactContinuationBuilder', () => {
  it('classifies compact rails without treating legacy notifications as primary truth', () => {
    expect(classifyCompactRail({ signal: 'item/completed', itemType: 'ContextCompaction' })).toEqual({
      kind: 'live',
      label: 'item/completed:ContextCompaction',
      primary: true,
    });
    expect(classifyCompactRail({ itemType: 'ThreadItem::ContextCompaction' })).toEqual({
      kind: 'durable',
      label: 'ThreadItem::ContextCompaction',
      primary: true,
    });
    expect(classifyCompactRail({ signal: 'thread/compacted' })).toEqual({
      kind: 'legacy',
      label: 'thread/compacted',
      primary: false,
    });
  });

  it('ingests a ContextCompaction item as a compact_summary sidecar event with explicit rail notes', () => {
    const event = buildCompactContinuationEvent({
      sessionId: 'session-1',
      cwd: '/repo',
      project: 'repo',
      compactItemId: 'compact-item-9',
      summary: 'Keep the phase truth, blockers, and next worker spine.',
      sourceRange: {
        fromEventId: 'event-1',
        toEventId: 'event-8',
      },
      observedAt: '2026-04-24T16:10:00.000Z',
    });

    expect(event).toEqual(expect.objectContaining({
      type: 'compact_summary',
      idempotencyKey: 'codex:session-1:compact_summary:compact-item-9',
      materialization: 'deferred',
      source: {
        rail: 'compact',
        role: 'compact_receipt',
        priority: 'sidecar',
        primaryRail: 'hooks',
        adapter: 'ContextCompaction',
      },
      session: {
        id: 'session-1',
        platformSource: 'codex',
        cwd: '/repo',
        project: 'repo',
      },
      payload: {
        trigger: 'unknown',
        summary: 'Keep the phase truth, blockers, and next worker spine.',
        sourceRange: {
          fromEventId: 'event-1',
          toEventId: 'event-8',
        },
      },
    }));
    expect(event.metadata).toEqual(expect.objectContaining({
      liveRail: ['item/started:ContextCompaction', 'item/completed:ContextCompaction'],
      durableRail: 'ThreadItem::ContextCompaction',
      legacyRails: ['ContextCompacted', 'thread/compacted'],
      continuationClaim: 'compact-aware continuation',
      forbiddenClaim: 'PreCompact parity',
    }));
  });

  it('extracts durable compact receipts from observations without accepting legacy-only evidence', () => {
    const durableEntries = extractDurableCompactRail([
      observation({ id: 1 }),
      observation({
        id: 2,
        title: 'legacy compact notification',
        narrative: 'thread/compacted was seen but no durable ContextCompaction item was retained.',
        facts: JSON.stringify({ legacyRail: 'thread/compacted' }),
        concepts: JSON.stringify(['thread/compacted']),
      }),
    ]);

    expect(durableEntries).toEqual([
      {
        observationId: 1,
        memorySessionId: 'session-1',
        durableRail: 'ThreadItem::ContextCompaction',
        summary: 'Recovered summary from durable compact rail.',
        createdAt: '2026-04-24T16:00:00.000Z',
      },
    ]);
  });

  it('builds a compact-after continuation spine from live event plus durable replay evidence', () => {
    const event = buildCompactContinuationEvent({
      sessionId: 'session-1',
      compactItemId: 'compact-item-9',
      summary: 'Keep Phase 3 residual failing point separate from Phase 4.',
    });
    const spine = buildCompactAfterContinuationSpine({
      event,
      durableEntries: [extractDurableCompactRail([observation({ id: 7 })])[0]],
    });

    expect(spine).toContain('Compact continuation spine');
    expect(spine).toContain('live rail: item/started:ContextCompaction, item/completed:ContextCompaction');
    expect(spine).toContain('durable rail: ThreadItem::ContextCompaction');
    expect(spine).toContain('legacy rails: ContextCompacted, thread/compacted');
    expect(spine).toContain('claim: compact-aware continuation');
    expect(spine).toContain('forbidden: PreCompact parity');
    expect(spine).toContain('Keep Phase 3 residual failing point separate from Phase 4.');
    expect(spine).toContain('durable receipt: #7 session-1');
  });
});
