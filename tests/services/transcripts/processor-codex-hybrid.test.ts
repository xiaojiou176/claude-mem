import { beforeEach, describe, expect, it, mock } from 'bun:test';

const sessionInitExecute = mock(async () => ({ continue: true, suppressOutput: true }));
const observationExecute = mock(async () => ({ continue: true, suppressOutput: true }));
const fileEditExecute = mock(async () => ({ continue: true, suppressOutput: true }));
const sessionCompleteExecute = mock(async () => ({ continue: true, suppressOutput: true }));
const workerHttpRequest = mock(async () => new Response('', { status: 204 }));

mock.module('../../../src/cli/handlers/session-init.js', () => ({
  sessionInitHandler: { execute: sessionInitExecute }
}));

mock.module('../../../src/cli/handlers/observation.js', () => ({
  observationHandler: { execute: observationExecute }
}));

mock.module('../../../src/cli/handlers/file-edit.js', () => ({
  fileEditHandler: { execute: fileEditExecute }
}));

mock.module('../../../src/cli/handlers/session-complete.js', () => ({
  sessionCompleteHandler: { execute: sessionCompleteExecute }
}));

mock.module('../../../src/shared/worker-utils.js', () => ({
  ensureWorkerRunning: mock(async () => true),
  workerHttpRequest
}));

const { TranscriptEventProcessor } = await import('../../../src/services/transcripts/processor.js');
const { saveWatchState, loadWatchState } = await import('../../../src/services/transcripts/state.js');
const { SAMPLE_CONFIG } = await import('../../../src/services/transcripts/config.js');

import type { TranscriptSchema, WatchTarget } from '../../../src/services/transcripts/types.js';

const watch: WatchTarget = {
  name: 'codex',
  path: '~/.codex/sessions/**/*.jsonl',
  schema: 'codex',
  workspace: '/repo/workspace',
  project: 'workspace'
};

const schema: TranscriptSchema = {
  name: 'codex',
  version: '0.3',
  description: 'Codex transcript source adapter test schema',
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
      name: 'tool-use',
      match: { path: 'payload.type', equals: 'function_call' },
      action: 'tool_use',
      fields: {
        toolId: 'payload.call_id',
        toolName: 'payload.name',
        toolInput: 'payload.arguments'
      }
    },
    {
      name: 'tool-result',
      match: { path: 'payload.type', equals: 'function_call_output' },
      action: 'tool_result',
      fields: {
        toolId: 'payload.call_id',
        toolResponse: 'payload.output'
      }
    },
    {
      name: 'session-end',
      match: { path: 'payload.type', equals: 'turn_completed' },
      action: 'session_end'
    }
  ]
};

describe('TranscriptEventProcessor Codex hybrid source adapter', () => {
  beforeEach(() => {
    sessionInitExecute.mockClear();
    observationExecute.mockClear();
    fileEditExecute.mockClear();
    sessionCompleteExecute.mockClear();
    workerHttpRequest.mockClear();
  });

  it('emits secondary canonical events instead of materializing transcript-derived session init', async () => {
    const processor = new TranscriptEventProcessor();

    await processor.processEntry(
      { type: 'session_meta', payload: { id: 'session-1', cwd: '/repo/workspace' } },
      watch,
      schema
    );
    const events = await processor.processEntry(
      { payload: { type: 'user_message', message: 'remember this refactor' } },
      watch,
      schema,
      'session-1'
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(expect.objectContaining({
      type: 'session_init',
      materialization: 'deferred',
      source: expect.objectContaining({
        rail: 'transcript',
        role: 'fallback_replay_audit',
        priority: 'secondary',
        primaryRail: 'hooks'
      }),
      replay: expect.objectContaining({
        mode: 'source_adapter',
        recovery: 'fill_missing_events_only',
        overwritePolicy: 'never_overwrite_hook_primary'
      }),
      payload: expect.objectContaining({ prompt: 'remember this refactor' })
    }));
    expect(events[0].idempotencyKey).toBe('codex:session-1:session_init');
    expect(events[0].session).toEqual(expect.objectContaining({
      id: 'session-1',
      cwd: '/repo/workspace',
      platformSource: 'codex'
    }));

    expect(sessionInitExecute).not.toHaveBeenCalled();
    expect(observationExecute).not.toHaveBeenCalled();
    expect(fileEditExecute).not.toHaveBeenCalled();
    expect(sessionCompleteExecute).not.toHaveBeenCalled();
    expect(workerHttpRequest).not.toHaveBeenCalled();
  });

  it('replays transcript tool completion and apply_patch edits as canonical backfill events', async () => {
    const processor = new TranscriptEventProcessor();

    await processor.processEntry(
      { type: 'session_meta', payload: { id: 'session-2', cwd: '/repo/workspace' } },
      watch,
      schema
    );
    const useEvents = await processor.processEntry(
      {
        payload: {
          type: 'function_call',
          call_id: 'call-1',
          name: 'apply_patch',
          arguments: '*** Begin Patch\n*** Update File: src/example.ts\n@@\n-old\n+new\n*** End Patch'
        }
      },
      watch,
      schema,
      'session-2'
    );
    const resultEvents = await processor.processEntry(
      {
        payload: {
          type: 'function_call_output',
          call_id: 'call-1',
          output: '{"exitCode":0,"stdout":"ok"}'
        }
      },
      watch,
      schema,
      'session-2'
    );

    expect(useEvents.map(event => event.type)).toEqual(['tool_use', 'file_edit']);
    expect(useEvents[0].idempotencyKey).toBe('codex:session-2:tool_use:call-1');
    expect(useEvents[1]).toEqual(expect.objectContaining({
      type: 'file_edit',
      idempotencyKey: 'codex:session-2:file_edit:src/example.ts:call-1',
      payload: expect.objectContaining({
        filePath: 'src/example.ts',
        toolName: 'apply_patch'
      })
    }));

    expect(resultEvents).toHaveLength(1);
    expect(resultEvents[0]).toEqual(expect.objectContaining({
      type: 'tool_result',
      idempotencyKey: 'codex:session-2:tool_result:call-1',
      replay: expect.objectContaining({
        lateArrivalPolicy: 'preserve_existing_order'
      }),
      payload: expect.objectContaining({
        toolId: 'call-1',
        toolName: 'apply_patch',
        toolResponse: { exitCode: 0, stdout: 'ok' }
      })
    }));

    expect(observationExecute).not.toHaveBeenCalled();
    expect(fileEditExecute).not.toHaveBeenCalled();
  });

  it('wraps transcript adapter output in the canonical replay envelope for downstream stitching', async () => {
    const processor = new TranscriptEventProcessor();

    await processor.processEntry(
      { type: 'session_meta', payload: { id: 'session-3', cwd: '/repo/workspace' } },
      watch,
      schema
    );
    const [event] = await processor.processEntry(
      { payload: { type: 'turn_completed' } },
      watch,
      schema,
      'session-3'
    );

    expect(event).toEqual(expect.objectContaining({
      schemaVersion: 'codex-event/v1',
      observedAt: expect.any(String),
      source: expect.objectContaining({
        rail: 'transcript',
        adapter: 'codex-transcript'
      }),
      metadata: expect.objectContaining({
        observedFrom: 'transcript-jsonl',
        replayRole: 'fallback_replay_audit'
      })
    }));
    expect(event.observedAt).toBe(event.audit.observedAt);
  });

  it('materializes a real Codex task_complete terminal event as session_end through the default schema', async () => {
    const processor = new TranscriptEventProcessor();
    const codexSchema = SAMPLE_CONFIG.schemas?.codex;
    const replayWatch: WatchTarget = {
      ...watch,
      context: {
        mode: 'agents',
        updateOn: ['session_start', 'session_end']
      }
    };

    if (!codexSchema) {
      throw new Error('Expected SAMPLE_CONFIG to include the Codex transcript schema');
    }

    await processor.processEntry(
      { type: 'session_meta', payload: { id: 'session-task-complete', cwd: '/repo/workspace' } },
      replayWatch,
      codexSchema
    );

    const events = await processor.processEntry(
      {
        timestamp: '2026-04-24T18:00:09.016Z',
        type: 'event_msg',
        payload: {
          type: 'task_complete',
          turn_id: '019dc0a5-e96c-7491-8da5-05eec5b9027e',
          last_agent_message: '/Users/yuyifeng/Documents/VS Code/1_Personal_Project/开源/claude-mem',
          completed_at: 1777053609,
          duration_ms: 17098,
          time_to_first_token_ms: 13022
        }
      },
      replayWatch,
      codexSchema,
      'session-task-complete'
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(expect.objectContaining({
      type: 'session_end',
      idempotencyKey: 'codex:session-task-complete:session_end',
      metadata: expect.objectContaining({
        schemaEventName: 'session-end'
      }),
      payload: expect.objectContaining({
        lastAssistantMessage: '',
        contextUpdateRequested: true
      })
    }));
  });

  it('persists replay cursor metadata without losing existing transcript offsets', () => {
    const statePath = `/tmp/claude-mem-transcript-state-${Date.now()}.json`;

    saveWatchState(statePath, {
      offsets: { '/tmp/session.jsonl': 42 },
      replay: {
        lastCanonicalEventId: 'codex:session-2:tool_result:call-1',
        mode: 'fallback_replay_audit',
        highWatermarks: {
          codex: 42
        }
      }
    });

    expect(loadWatchState(statePath)).toEqual({
      offsets: { '/tmp/session.jsonl': 42 },
      replay: {
        lastCanonicalEventId: 'codex:session-2:tool_result:call-1',
        mode: 'fallback_replay_audit',
        highWatermarks: {
          codex: 42
        }
      }
    });
  });
});
