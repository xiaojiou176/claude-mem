import { describe, expect, it } from 'bun:test';

import {
  buildEventIdentity,
  normalizeEventIdentityPart,
} from '../../../src/services/codex-events/EventIdentity.js';
import type { StitchableEvent } from '../../../src/services/codex-events/EventIdentity.js';

function event(overrides: Partial<StitchableEvent>): StitchableEvent {
  return {
    type: 'tool_result',
    session: { id: 'session-1', platformSource: 'codex' },
    payload: {
      toolId: 'call-1',
      toolName: 'apply_patch',
    },
    source: { rail: 'hook', role: 'primary', priority: 'primary' },
    ...overrides,
  };
}

describe('EventIdentity', () => {
  it('builds stable identity for the same hook and transcript tool completion', () => {
    const hookEvent = event({
      idempotencyKey: 'codex:session-1:tool_result:call-1',
      source: { rail: 'hook', role: 'primary', priority: 'primary' },
    });
    const transcriptEvent = event({
      source: {
        rail: 'transcript',
        role: 'fallback_replay_audit',
        priority: 'secondary',
      },
    });

    expect(buildEventIdentity(hookEvent)).toBe('codex:session-1:tool_result:call-1');
    expect(buildEventIdentity(transcriptEvent)).toBe('codex:session-1:tool_result:call-1');
  });

  it('includes file path and tool id for apply_patch file edit backfill identity', () => {
    expect(
      buildEventIdentity(
        event({
          type: 'file_edit',
          payload: {
            filePath: 'src/example.ts',
            toolId: 'call-1',
            toolName: 'apply_patch',
          },
        }),
      ),
    ).toBe('codex:session-1:file_edit:src/example.ts:call-1');
  });

  it('normalizes unsafe and empty identity parts without losing deterministic dedupe', () => {
    expect(normalizeEventIdentityPart('  User Prompt / Submit  ')).toBe('user-prompt-submit');
    expect(normalizeEventIdentityPart('')).toBe('unknown');
    expect(normalizeEventIdentityPart(null)).toBe('unknown');
  });
});
