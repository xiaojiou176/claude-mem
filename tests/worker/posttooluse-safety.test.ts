import { describe, expect, it, mock } from 'bun:test';
import { EventEmitter } from 'node:events';
import {
  MAX_OBSERVATION_QUEUE_DEPTH,
  SessionManager,
} from '../../src/services/worker/SessionManager.js';
import type { PendingMessage } from '../../src/services/worker-types.js';
import { sanitizeObservationPayload, SessionRoutes } from '../../src/services/worker/http/routes/SessionRoutes.js';

const COMMON_POSTTOOLUSE_TOOL_FAMILIES = [
  {
    tool_name: 'Bash',
    tool_input: { command: 'printf ok' },
    tool_response: { output: 'ok' },
    toolUseId: 'call_bash_family',
  },
  {
    tool_name: 'apply_patch',
    tool_input: '*** Begin Patch\n*** End Patch\n',
    tool_response: { exit_code: 0 },
    toolUseId: 'call_apply_patch_family',
  },
  {
    tool_name: 'mcp__serena__find_symbol',
    tool_input: { name_path: 'resolveAgentsMdProjectionTarget' },
    tool_response: { symbols: [{ name: 'resolveAgentsMdProjectionTarget' }] },
    toolUseId: 'call_mcp_family',
  },
  {
    tool_name: 'Read',
    tool_input: { file_path: '/repo/AGENTS.md' },
    tool_response: '# repo rules',
    toolUseId: 'call_read_family',
  },
] as const;

function makeSessionManagerHarness(
  pendingCount = 0,
  options: {
    hasActiveDuplicateObservation?: boolean;
    pendingObservationToolCount?: number;
  } = {},
) {
  const enqueued: PendingMessage[] = [];
  const manager = new SessionManager({} as any);

  (manager as any).pendingStore = {
    hasActiveDuplicateObservation: () => options.hasActiveDuplicateObservation ?? false,
    getPendingObservationToolCount: () => options.pendingObservationToolCount ?? 0,
    enqueue: (_sessionDbId: number, _contentSessionId: string, message: PendingMessage) => {
      enqueued.push(message);
      return enqueued.length;
    },
    getPendingCount: () => pendingCount + enqueued.length,
  };

  (manager as any).sessions.set(1, {
    sessionDbId: 1,
    contentSessionId: 'codex-session-1',
    memorySessionId: null,
    project: 'repo',
    platformSource: 'codex',
    userPrompt: 'prompt',
    pendingMessages: [],
    abortController: new AbortController(),
    generatorPromise: null,
    lastPromptNumber: 1,
    startTime: Date.now(),
    cumulativeInputTokens: 0,
    cumulativeOutputTokens: 0,
    earliestPendingTimestamp: null,
    conversationHistory: [],
    currentProvider: null,
    consecutiveRestarts: 0,
    processingMessageIds: [],
    lastGeneratorActivity: Date.now(),
    consecutiveSummaryFailures: 0,
    pendingAgentId: null,
    pendingAgentType: null,
  });
  (manager as any).sessionQueues.set(1, new EventEmitter());

  return { manager, enqueued };
}

describe('PostToolUse safety guards', () => {
  it('redacts secrets and caps observation payloads at the SessionRoutes boundary', () => {
    const payload = sanitizeObservationPayload(
      JSON.stringify({
        token: 'ghp_abcdef1234567890',
        api_key: 'sk-testsecret1234567890',
        bearer: 'Bearer abcdefghijklmnopqrstuvwxyz0123456789',
        note: 'x'.repeat(20_000),
      }),
    );

    expect(payload).not.toContain('ghp_abcdef1234567890');
    expect(payload).not.toContain('sk-testsecret1234567890');
    expect(payload).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789');
    expect(payload.length).toBeLessThanOrEqual(16_060);
  });

  it('dedupes repeated Codex tool_use_id before adding duplicate observation work', () => {
    const { manager, enqueued } = makeSessionManagerHarness();

    const first = manager.queueObservation(1, {
      tool_name: 'Bash',
      tool_input: { command: 'printf ok' },
      tool_response: 'ok',
      prompt_number: 1,
      cwd: '/repo',
      toolUseId: 'call_bash_1',
    });
    const duplicate = manager.queueObservation(1, {
      tool_name: 'Bash',
      tool_input: { command: 'printf ok' },
      tool_response: 'ok again',
      prompt_number: 1,
      cwd: '/repo',
      toolUseId: 'call_bash_1',
    });

    expect(first).toEqual({ queued: true, queueDepth: 1 });
    expect(duplicate).toEqual({ queued: false, reason: 'duplicate_tool_use', queueDepth: 1 });
    expect(enqueued).toHaveLength(1);
  });

  it('dedupes active duplicate observation work from the persistent queue after a worker restart', () => {
    const { manager, enqueued } = makeSessionManagerHarness(1, {
      hasActiveDuplicateObservation: true,
    });

    const duplicateAfterRestart = manager.queueObservation(1, {
      tool_name: 'Bash',
      tool_input: { command: 'printf ok' },
      tool_response: 'ok',
      prompt_number: 1,
      cwd: '/repo',
      toolUseId: 'call_bash_after_restart',
    });

    expect(duplicateAfterRestart).toEqual({
      queued: false,
      reason: 'duplicate_tool_use',
      queueDepth: 1,
    });
    expect(enqueued).toHaveLength(0);
  });

  it('rejects additional observation work when a session is already at the queue-depth cap', () => {
    const { manager, enqueued } = makeSessionManagerHarness(MAX_OBSERVATION_QUEUE_DEPTH);

    const result = manager.queueObservation(1, {
      tool_name: 'Bash',
      tool_input: { command: 'printf ok' },
      tool_response: 'ok',
      prompt_number: 1,
      cwd: '/repo',
      toolUseId: 'call_bash_over_cap',
    });

    expect(result).toEqual({
      queued: false,
      reason: 'queue_backpressure',
      queueDepth: MAX_OBSERVATION_QUEUE_DEPTH,
    });
    expect(enqueued).toHaveLength(0);
  });

  it('reserves queue capacity for other tools when one tool family dominates the backlog', () => {
    const perToolReserveThreshold = Math.floor(MAX_OBSERVATION_QUEUE_DEPTH * 0.8);
    const { manager, enqueued } = makeSessionManagerHarness(perToolReserveThreshold, {
      pendingObservationToolCount: perToolReserveThreshold,
    });

    const result = manager.queueObservation(1, {
      tool_name: 'Bash',
      tool_input: { command: 'printf ok' },
      tool_response: 'ok',
      prompt_number: 1,
      cwd: '/repo',
      toolUseId: 'call_bash_tool_family_saturated',
    });

    expect(result).toEqual({
      queued: false,
      reason: 'tool_backpressure',
      queueDepth: perToolReserveThreshold,
    });
    expect(enqueued).toHaveLength(0);
  });

  it('keeps a bounded repo-side PostToolUse coverage matrix for common tool families', () => {
    const { manager, enqueued } = makeSessionManagerHarness();

    const results = COMMON_POSTTOOLUSE_TOOL_FAMILIES.map((fixture) =>
      manager.queueObservation(1, {
        tool_name: fixture.tool_name,
        tool_input: fixture.tool_input,
        tool_response: fixture.tool_response,
        prompt_number: 1,
        cwd: '/repo',
        toolUseId: fixture.toolUseId,
      })
    );

    expect(results).toEqual(
      COMMON_POSTTOOLUSE_TOOL_FAMILIES.map((_, index) => ({
        queued: true,
        queueDepth: index + 1,
      }))
    );
    expect(enqueued.map((message) => message.tool_name)).toEqual([
      'Bash',
      'apply_patch',
      'mcp__serena__find_symbol',
      'Read',
    ]);
  });

  it('restarts an aborted in-flight generator when pending observation work is still queued', () => {
    const abortController = new AbortController();
    abortController.abort();

    const session: any = {
      sessionDbId: 1,
      contentSessionId: 'codex-session-aborted-generator',
      memorySessionId: null,
      project: 'repo',
      platformSource: 'codex',
      userPrompt: 'prompt',
      pendingMessages: [],
      abortController,
      generatorPromise: new Promise<void>(() => {}),
      lastPromptNumber: 1,
      startTime: Date.now(),
      cumulativeInputTokens: 0,
      cumulativeOutputTokens: 0,
      earliestPendingTimestamp: null,
      conversationHistory: [],
      currentProvider: 'claude',
      consecutiveRestarts: 0,
      processingMessageIds: [],
      lastGeneratorActivity: Date.now(),
      consecutiveSummaryFailures: 0,
      pendingAgentId: null,
      pendingAgentType: null,
    };

    const pendingStore = {
      getPendingCount: mock(() => 1),
      peekPendingTypes: mock(() => [{ message_type: 'observation', tool_name: 'Bash' }]),
    };
    const sessionManager = {
      getSession: mock(() => session),
      getPendingMessageStore: mock(() => pendingStore),
    };
    const dbManager = {
      getSessionStore: mock(() => ({
        db: {
          prepare: mock(() => ({
            get: mock(() => ({ started_at_epoch: Date.now() })),
          })),
        },
      })),
    };
    const sdkAgent = {
      startSession: mock(() => new Promise<void>(() => {})),
    };
    const workerService = {
      broadcastProcessingStatus: mock(() => {}),
    };

    const routes = new SessionRoutes(
      sessionManager as any,
      dbManager as any,
      sdkAgent as any,
      {} as any,
      {} as any,
      {} as any,
      workerService as any,
      {} as any,
    ) as any;

    routes.ensureGeneratorRunning(1, 'session-complete-pending-work');

    expect(sdkAgent.startSession).toHaveBeenCalledTimes(1);
    expect(session.abortController.signal.aborted).toBe(false);
    expect(session.generatorPromise).toBeInstanceOf(Promise);
  });
});
