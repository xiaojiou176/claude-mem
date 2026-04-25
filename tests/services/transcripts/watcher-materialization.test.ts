import { describe, expect, it, mock } from 'bun:test';
import { TranscriptWatcher } from '../../../src/services/transcripts/watcher.js';

const sessionInitExecute = mock(async () => ({ continue: true, suppressOutput: true }));
const observationExecute = mock(async () => ({ continue: true, suppressOutput: true }));
const fileEditExecute = mock(async () => ({ continue: true, suppressOutput: true }));
const summarizeExecute = mock(async () => ({ continue: true, suppressOutput: true }));
const sessionCompleteExecute = mock(async () => ({ continue: true, suppressOutput: true }));
const workerHttpRequest = mock(async () => new Response('projected context', { status: 200 }));
const writeAgentsMd = mock(() => {});
const createSDKSession = mock(() => 7);
const getSessionById = mock(() => ({
  id: 7,
  content_session_id: 'session-1',
  memory_session_id: null,
  project: 'repo',
  platform_source: 'codex',
  user_prompt: '',
  custom_title: null,
  status: 'active',
}));
const ensureMemorySessionIdRegistered = mock(() => {});
const storeObservation = mock(() => ({ id: 1, createdAtEpoch: Date.now() }));
const createSessionStore = mock(() => ({
  createSDKSession,
  getSessionById,
  ensureMemorySessionIdRegistered,
  storeObservation,
}));

describe('TranscriptWatcher canonical event materialization', () => {
  it('consumes processor-returned canonical events instead of dropping them', async () => {
    sessionInitExecute.mockClear();
    observationExecute.mockClear();
    fileEditExecute.mockClear();
    summarizeExecute.mockClear();
    sessionCompleteExecute.mockClear();
    workerHttpRequest.mockClear();
    writeAgentsMd.mockClear();
    createSDKSession.mockClear();
    ensureMemorySessionIdRegistered.mockClear();
    storeObservation.mockClear();
    createSessionStore.mockClear();

    const watcher = new TranscriptWatcher(
      { version: 1, watches: [], schemas: {} },
      '/tmp/phase5-watcher-state.json',
      {
        sessionInitExecute,
        observationExecute,
        fileEditExecute,
        summarizeExecute,
        sessionCompleteExecute,
        workerHttpRequest,
        writeAgentsMd,
        createSessionStore,
      }
    ) as any;
    watcher.processor = {
      processEntry: async () => [
        {
          type: 'session_init',
          session: { id: 'session-1', cwd: '/repo/root', project: 'repo', platformSource: 'codex' },
          payload: {
            prompt: 'hello',
            contextProjection: { targetPath: '/repo/root/AGENTS.md' },
          },
        },
        {
          type: 'observation',
          session: { id: 'session-1', cwd: '/repo/root', project: 'repo', platformSource: 'codex' },
          payload: { toolName: 'Bash', toolInput: { command: 'pwd' }, toolResponse: 'ok' },
        },
        {
          type: 'file_edit',
          session: { id: 'session-1', cwd: '/repo/root', project: 'repo', platformSource: 'codex' },
          payload: { filePath: 'src/example.ts', edits: [{ type: 'apply_patch' }] },
        },
        {
          type: 'child_session',
          observedAt: new Date().toISOString(),
          session: { id: 'session-1', cwd: '/repo/root', project: 'repo', platformSource: 'codex' },
          payload: { childSessionId: 'child-1', agentId: 'child-1', agentType: 'codex-subagent', status: 'completed' },
          metadata: { terminalMessage: 'done' },
        },
        {
          type: 'compact_summary',
          observedAt: new Date().toISOString(),
          session: { id: 'session-1', cwd: '/repo/root', project: 'repo', platformSource: 'codex' },
          payload: { summary: 'compacted' },
        },
        {
          type: 'session_end',
          session: { id: 'session-1', cwd: '/repo/root', project: 'repo', platformSource: 'codex' },
          payload: {
            lastAssistantMessage: 'bye',
            contextProjection: { targetPath: '/repo/root/AGENTS.md' },
          },
        },
      ],
    };

    await watcher.handleLine(
      JSON.stringify({ payload: { type: 'user_message', message: 'ignored by mocked processor' } }),
      { name: 'codex', path: '/tmp/*.jsonl', schema: 'codex' },
      { name: 'codex', events: [] },
      '/tmp/session.jsonl',
      'session-1',
    );

    expect(sessionInitExecute).toHaveBeenCalledTimes(1);
    expect(observationExecute).toHaveBeenCalledTimes(1);
    expect(fileEditExecute).toHaveBeenCalledTimes(1);
    expect(summarizeExecute).toHaveBeenCalledTimes(1);
    expect(sessionCompleteExecute).toHaveBeenCalledTimes(1);
    expect(writeAgentsMd).toHaveBeenCalledTimes(2);
    expect(workerHttpRequest).toHaveBeenCalledTimes(2);
    expect(createSessionStore).toHaveBeenCalledTimes(2);
    expect(createSDKSession).toHaveBeenCalledTimes(2);
    expect(ensureMemorySessionIdRegistered).toHaveBeenCalledTimes(2);
    expect(storeObservation).toHaveBeenCalledTimes(2);
  });
});
