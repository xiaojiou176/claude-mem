import { describe, expect, it } from 'bun:test';
import { TranscriptEventProcessor } from '../../../src/services/transcripts/processor.js';
import type { TranscriptSchema, WatchTarget } from '../../../src/services/transcripts/types.js';
import { resolveAgentsMdProjectionTarget } from '../../../src/utils/agents-md-utils.js';

const schema: TranscriptSchema = {
  name: 'codex',
  version: '0.4',
  events: [
    {
      name: 'session-meta',
      match: { path: 'type', equals: 'session_meta' },
      action: 'session_context',
      fields: {
        sessionId: 'payload.id',
        cwd: 'payload.cwd'
      }
    },
    {
      name: 'user-message',
      match: { path: 'payload.type', equals: 'user_message' },
      action: 'session_init',
      fields: {
        prompt: 'payload.message'
      }
    },
    {
      name: 'session-end',
      match: { path: 'payload.type', equals: 'turn_completed' },
      action: 'session_end'
    }
  ]
};

describe('TranscriptEventProcessor AGENTS projection cwd drift', () => {
  it('keeps AGENTS projection anchored to workspace root while honestly retaining observed nested cwd', async () => {
    const processor = new TranscriptEventProcessor();
    const watch: WatchTarget = {
      name: 'codex',
      path: '~/.codex/sessions/**/*.jsonl',
      schema: 'codex',
      workspace: '/repo/root',
      context: {
        mode: 'agents',
        updateOn: ['session_start']
      }
    };

    await processor.processEntry(
      { type: 'session_meta', payload: { id: 'session-cwd-drift', cwd: '/repo/root/packages/nested' } },
      watch,
      schema
    );
    const [event] = await processor.processEntry(
      { payload: { type: 'user_message', message: 'shape context' } },
      watch,
      schema,
      'session-cwd-drift'
    );

    expect(event.session.cwd).toBe('/repo/root/packages/nested');
    expect(event.session.project).toBe('root');
    expect(event.payload.contextUpdateRequested).toBe(true);
    expect(event.payload.contextProjection).toEqual(expect.objectContaining({
      mode: 'agents',
      role: 'projection_sink_not_storage',
      trigger: 'session_start',
      targetPath: '/repo/root/AGENTS.md',
      targetScope: 'workspace',
      precedence: 'explicit_context_path > watch.workspace > observed_cwd',
      codexScopeNote: 'root/nested AGENTS accumulate; same-directory AGENTS.override.md masks AGENTS.md'
    }));
    expect((event.payload.contextProjection as any).cwdDrift).toEqual({
      workspace: '/repo/root',
      observedCwd: '/repo/root/packages/nested',
      status: 'observed_cwd_nested_under_workspace_projection_stays_at_workspace_root'
    });
  });

  it('uses nearest git root project for session project while honestly retaining observed nested cwd', async () => {
    const { mkdtempSync, mkdirSync, rmSync } = await import('fs');
    const { join } = await import('path');
    const { tmpdir } = await import('os');

    const tmp = mkdtempSync(join(tmpdir(), 'cm-processor-scope-'));
    const repoRoot = join(tmp, 'scope-root-project');
    const nestedCwd = join(repoRoot, 'packages', 'nested');

    mkdirSync(join(repoRoot, '.git'), { recursive: true });
    mkdirSync(nestedCwd, { recursive: true });

    try {
      const processor = new TranscriptEventProcessor();
      const watch: WatchTarget = {
        name: 'codex',
        path: '~/.codex/sessions/**/*.jsonl',
        schema: 'codex',
        workspace: tmp,
        context: {
          mode: 'agents',
          updateOn: ['session_start']
        }
      };

      await processor.processEntry(
        { type: 'session_meta', payload: { id: 'session-nearest-git-root', cwd: nestedCwd } },
        watch,
        schema
      );
      const [event] = await processor.processEntry(
        { payload: { type: 'user_message', message: 'shape context' } },
        watch,
        schema,
        'session-nearest-git-root'
      );

      expect(event.session.cwd).toBe(nestedCwd);
      expect(event.session.project).toBe('scope-root-project');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('does not request AGENTS projection outside configured updateOn triggers', async () => {
    const processor = new TranscriptEventProcessor();
    const watch: WatchTarget = {
      name: 'codex',
      path: '~/.codex/sessions/**/*.jsonl',
      schema: 'codex',
      workspace: '/repo/root',
      context: {
        mode: 'agents',
        updateOn: ['session_end']
      }
    };

    await processor.processEntry(
      { type: 'session_meta', payload: { id: 'session-updateon', cwd: '/repo/root' } },
      watch,
      schema
    );
    const [startEvent] = await processor.processEntry(
      { payload: { type: 'user_message', message: 'start only' } },
      watch,
      schema,
      'session-updateon'
    );
    const [endEvent] = await processor.processEntry(
      { payload: { type: 'turn_completed' } },
      watch,
      schema,
      'session-updateon'
    );

    expect(startEvent.payload.contextUpdateRequested).toBe(false);
    expect(startEvent.payload.contextProjection).toBeUndefined();
    expect(endEvent.payload.contextUpdateRequested).toBe(true);
    expect((endEvent.payload.contextProjection as any).trigger).toBe('session_end');
    expect((endEvent.payload.contextProjection as any).targetPath).toBe('/repo/root/AGENTS.md');
  });

  it('uses explicit context.path before workspace or observed cwd for override-style projection', () => {
    expect(resolveAgentsMdProjectionTarget({
      contextPath: 'codex/AGENTS.md',
      workspace: '/repo/root',
      cwd: '/repo/root/packages/nested'
    })).toEqual(expect.objectContaining({
      targetPath: '/repo/root/codex/AGENTS.md',
      targetScope: 'explicit',
      precedence: 'explicit_context_path > watch.workspace > observed_cwd',
      cwdDriftStatus: 'explicit_context_path_controls_projection_target'
    }));
  });
});
