import { describe, expect, it } from 'bun:test';

import {
  compareEventPriority,
  getEventPriority,
  SOURCE_PRIORITY_TABLE,
  shouldReplaceEventTruth,
} from '../../../src/services/codex-events/EventPriority.js';
import type { StitchableEvent } from '../../../src/services/codex-events/EventIdentity.js';

function event(source: StitchableEvent['source']): StitchableEvent {
  return {
    type: 'session_init',
    session: { id: 'session-1', platformSource: 'codex' },
    payload: { prompt: 'hello' },
    source,
  };
}

describe('EventPriority', () => {
  it('declares hook as primary and transcript as fallback/replay/audit secondary', () => {
    expect(SOURCE_PRIORITY_TABLE.hook).toEqual(
      expect.objectContaining({
        rank: 100,
        railRole: 'primary',
        overwritePolicy: 'wins_over_lower_priority',
      }),
    );
    expect(SOURCE_PRIORITY_TABLE.transcript).toEqual(
      expect.objectContaining({
        rank: 10,
        railRole: 'fallback_replay_audit',
        overwritePolicy: 'fill_gaps_only',
      }),
    );
  });

  it('ranks hook above transcript even when transcript arrives later', () => {
    const hookEvent = event({ rail: 'hook', role: 'primary', priority: 'primary' });
    const transcriptEvent = event({
      rail: 'transcript',
      role: 'fallback_replay_audit',
      priority: 'secondary',
    });

    expect(getEventPriority(hookEvent).rank).toBeGreaterThan(getEventPriority(transcriptEvent).rank);
    expect(compareEventPriority(hookEvent, transcriptEvent)).toBeGreaterThan(0);
    expect(shouldReplaceEventTruth(transcriptEvent, hookEvent)).toBe(false);
    expect(shouldReplaceEventTruth(hookEvent, transcriptEvent)).toBe(true);
  });

  it('leaves same-priority ties stable instead of replacing existing truth', () => {
    const firstHook = event({ rail: 'hook', role: 'primary', priority: 'primary' });
    const laterHook = event({ rail: 'hook', role: 'primary', priority: 'primary' });

    expect(compareEventPriority(laterHook, firstHook)).toBe(0);
    expect(shouldReplaceEventTruth(laterHook, firstHook)).toBe(false);
  });
});
