/**
 * Hook Execution End-to-End Integration Tests
 *
 * Tests the full session lifecycle: SessionStart -> PostToolUse -> SessionEnd
 * Uses real worker on test port with in-memory SQLite database.
 *
 * Sources:
 * - Hook implementations from src/hooks/*.ts
 * - Session routes from src/services/worker/http/routes/SessionRoutes.ts
 * - Server patterns from tests/server/server.test.ts
 */

import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { logger } from '../../src/utils/logger.js';

// Mock middleware to avoid complex dependencies
mock.module('../../src/services/worker/http/middleware.js', () => ({
  createMiddleware: () => [],
  requireLocalhost: (_req: any, _res: any, next: any) => next(),
  summarizeRequestBody: () => 'test body',
}));

// Import after mocks
import { Server } from '../../src/services/server/Server.js';
import type { ServerOptions } from '../../src/services/server/Server.js';

// Suppress logger output during tests
let loggerSpies: ReturnType<typeof spyOn>[] = [];

describe('Hook Execution E2E', () => {
  let server: Server;
  let testPort: number;
  let mockOptions: ServerOptions;

  beforeEach(() => {
    loggerSpies = [
      spyOn(logger, 'info').mockImplementation(() => {}),
      spyOn(logger, 'debug').mockImplementation(() => {}),
      spyOn(logger, 'warn').mockImplementation(() => {}),
      spyOn(logger, 'error').mockImplementation(() => {}),
    ];

    mockOptions = {
      getInitializationComplete: () => true,
      getMcpReady: () => true,
      onShutdown: mock(() => Promise.resolve()),
      onRestart: mock(() => Promise.resolve()),
      workerPath: '/test/worker-service.cjs',
      getAiStatus: () => ({
        provider: 'claude',
        authMethod: 'cli',
        lastInteraction: null,
      }),
    };

    testPort = 40000 + Math.floor(Math.random() * 10000);
  });

  afterEach(async () => {
    loggerSpies.forEach(spy => spy.mockRestore());

    if (server && server.getHttpServer()) {
      try {
        await server.close();
      } catch {
        // Ignore errors on cleanup
      }
    }
    mock.restore();
  });

  describe('health and readiness endpoints', () => {
    it('should return 200 with status ok from /api/health', async () => {
      server = new Server(mockOptions);
      await server.listen(testPort, '127.0.0.1');

      const response = await fetch(`http://127.0.0.1:${testPort}/api/health`);
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.status).toBe('ok');
      expect(body.initialized).toBe(true);
      expect(body.mcpReady).toBe(true);
      expect(body.platform).toBeDefined();
      expect(typeof body.pid).toBe('number');
    });

    it('should return 200 with status ready from /api/readiness when initialized', async () => {
      server = new Server(mockOptions);
      await server.listen(testPort, '127.0.0.1');

      const response = await fetch(`http://127.0.0.1:${testPort}/api/readiness`);
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.status).toBe('ready');
    });

    it('should return 503 from /api/readiness when not initialized', async () => {
      const uninitializedOptions: ServerOptions = {
        getInitializationComplete: () => false,
        getMcpReady: () => false,
        onShutdown: mock(() => Promise.resolve()),
        onRestart: mock(() => Promise.resolve()),
        workerPath: '/test/worker-service.cjs',
        getAiStatus: () => ({ provider: 'claude', authMethod: 'cli', lastInteraction: null }),
      };

      server = new Server(uninitializedOptions);
      await server.listen(testPort, '127.0.0.1');

      const response = await fetch(`http://127.0.0.1:${testPort}/api/readiness`);
      expect(response.status).toBe(503);

      const body = await response.json();
      expect(body.status).toBe('initializing');
      expect(body.message).toBeDefined();
    });

    it('should return version from /api/version', async () => {
      server = new Server(mockOptions);
      await server.listen(testPort, '127.0.0.1');

      const response = await fetch(`http://127.0.0.1:${testPort}/api/version`);
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.version).toBeDefined();
      expect(typeof body.version).toBe('string');
    });
  });

  describe('server lifecycle', () => {
    it('should start and stop cleanly', async () => {
      server = new Server(mockOptions);
      await server.listen(testPort, '127.0.0.1');

      const httpServer = server.getHttpServer();
      expect(httpServer).not.toBeNull();
      expect(httpServer!.listening).toBe(true);

      // Verify health endpoint works
      const response = await fetch(`http://127.0.0.1:${testPort}/api/health`);
      expect(response.status).toBe(200);

      // Close server
      try {
        await server.close();
      } catch (e: any) {
        if (e.code !== 'ERR_SERVER_NOT_RUNNING') {
          throw e;
        }
      }

      const httpServerAfter = server.getHttpServer();
      if (httpServerAfter) {
        expect(httpServerAfter.listening).toBe(false);
      }
    });

    it('should reflect initialization state changes dynamically', async () => {
      let isInitialized = false;
      const dynamicOptions: ServerOptions = {
        getInitializationComplete: () => isInitialized,
        getMcpReady: () => true,
        onShutdown: mock(() => Promise.resolve()),
        onRestart: mock(() => Promise.resolve()),
        workerPath: '/test/worker-service.cjs',
        getAiStatus: () => ({ provider: 'claude', authMethod: 'cli', lastInteraction: null }),
      };

      server = new Server(dynamicOptions);
      await server.listen(testPort, '127.0.0.1');

      // Check when not initialized
      let response = await fetch(`http://127.0.0.1:${testPort}/api/health`);
      let body = await response.json();
      expect(body.initialized).toBe(false);

      // Change state
      isInitialized = true;

      // Check when initialized
      response = await fetch(`http://127.0.0.1:${testPort}/api/health`);
      body = await response.json();
      expect(body.initialized).toBe(true);
    });
  });

  describe('route handling', () => {
    it('should return 404 for unknown routes after finalizeRoutes', async () => {
      server = new Server(mockOptions);
      server.finalizeRoutes();
      await server.listen(testPort, '127.0.0.1');

      const response = await fetch(`http://127.0.0.1:${testPort}/api/nonexistent`);
      expect(response.status).toBe(404);

      const body = await response.json();
      expect(body.error).toBe('NotFound');
    });

    it('should accept JSON content type for POST requests', async () => {
      server = new Server(mockOptions);
      server.finalizeRoutes();
      await server.listen(testPort, '127.0.0.1');

      // Even though this endpoint doesn't exist, verify JSON handling
      const response = await fetch(`http://127.0.0.1:${testPort}/api/test-json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ test: 'data' })
      });

      // Should get 404 (not found), not 400 (bad request due to JSON parsing)
      expect(response.status).toBe(404);
    });
  });

  describe('privacy tag handling simulation', () => {
    it('should demonstrate privacy skip flow for entirely private prompt', async () => {
      // This test simulates what the session init endpoint does
      // with private prompts, without needing the full route handler
      server = new Server(mockOptions);
      await server.listen(testPort, '127.0.0.1');

      // Import tag stripping utility
      const { stripMemoryTagsFromPrompt } = await import('../../src/utils/tag-stripping.js');

      // Simulate the flow
      const privatePrompt = '<private>secret command</private>';
      const cleanedPrompt = stripMemoryTagsFromPrompt(privatePrompt);

      // Verify privacy check would skip this prompt
      const shouldSkip = !cleanedPrompt || cleanedPrompt.trim() === '';
      expect(shouldSkip).toBe(true);
    });

    it('should demonstrate partial privacy for mixed prompts', async () => {
      server = new Server(mockOptions);
      await server.listen(testPort, '127.0.0.1');

      const { stripMemoryTagsFromPrompt } = await import('../../src/utils/tag-stripping.js');

      const mixedPrompt = '<private>my password is secret123</private> Help me write a function';
      const cleanedPrompt = stripMemoryTagsFromPrompt(mixedPrompt);

      // Should not skip - has public content
      const shouldSkip = !cleanedPrompt || cleanedPrompt.trim() === '';
      expect(shouldSkip).toBe(false);
      expect(cleanedPrompt.trim()).toBe('Help me write a function');
    });
  });
});

describe('Codex hook-first basic wiring', () => {
  it('builds Codex hooks that route the four Phase 1 events into current handlers', async () => {
    const { buildCodexHookConfig } = await import('../../src/services/integrations/CodexCliInstaller.js');

    const config = buildCodexHookConfig('/bin/bun', '/tmp/worker-service.cjs');

    expect(Object.keys(config.hooks).sort()).toEqual([
      'PostToolUse',
      'SessionStart',
      'Stop',
      'UserPromptSubmit',
    ].sort());

    expect(config.hooks.SessionStart[0].hooks[0].command).toBe('"/bin/bun" "/tmp/worker-service.cjs" hook codex-cli context');
    expect(config.hooks.UserPromptSubmit[0].hooks[0].command).toBe('"/bin/bun" "/tmp/worker-service.cjs" hook codex-cli session-init');
    expect(config.hooks.PostToolUse[0].hooks[0].command).toBe('"/bin/bun" "/tmp/worker-service.cjs" hook codex-cli observation');
    expect(config.hooks.Stop[0].hooks[0].command).toBe('"/bin/bun" "/tmp/worker-service.cjs" hook codex-cli summarize');
  });

  it('merges Codex hooks without deleting existing non-claude-mem hooks', async () => {
    const {
      buildCodexHookConfig,
      mergeCodexHooksIntoConfig,
    } = await import('../../src/services/integrations/CodexCliInstaller.js');

    const existing: any = {
      hooks: {
        SessionStart: [
          {
            matcher: '*',
            hooks: [
              {
                type: 'command',
                name: 'operator-recorder',
                command: 'python3 /tmp/recorder.py SessionStart',
                timeout: 10,
              },
            ],
          },
          {
            matcher: '*',
            hooks: [
              {
                type: 'command',
                name: 'claude-mem',
                command: 'old claude-mem command',
                timeout: 10,
              },
            ],
          },
        ],
      },
    };

    const codexHooks = buildCodexHookConfig('/bin/bun', '/tmp/worker-service.cjs');
    const merged = mergeCodexHooksIntoConfig(existing, codexHooks);
    const sessionStartHooks = merged.hooks.SessionStart.flatMap((group) => group.hooks);

    expect(sessionStartHooks.some((hook) => hook.name === 'operator-recorder')).toBe(true);
    expect(sessionStartHooks.filter((hook) => hook.name === 'claude-mem')).toHaveLength(1);
    expect(sessionStartHooks.find((hook) => hook.name === 'claude-mem')?.command)
      .toBe('"/bin/bun" "/tmp/worker-service.cjs" hook codex-cli context');
    expect(merged.hooks.UserPromptSubmit[0].hooks[0].command)
      .toBe('"/bin/bun" "/tmp/worker-service.cjs" hook codex-cli session-init');
  });

  it('routes Codex SessionStart/UserPromptSubmit/PostToolUse/Stop through handler mainlines', async () => {
    const requests: Array<{ path: string; init?: RequestInit }> = [];
    const previousSemanticInject = process.env.CLAUDE_MEM_SEMANTIC_INJECT;
    process.env.CLAUDE_MEM_SEMANTIC_INJECT = 'true';

    mock.module('../../src/shared/worker-utils.js', () => ({
      ensureWorkerRunning: async () => true,
      getWorkerPort: () => 37777,
      workerHttpRequest: async (path: string, init?: RequestInit) => {
        requests.push({ path, init });

        if (path.startsWith('/api/context/inject')) {
          return new Response('codex startup context', { status: 200 });
        }
        if (path === '/api/sessions/init') {
          return Response.json({ sessionDbId: 42, promptNumber: 1, contextInjected: false });
        }
        if (path === '/sessions/42/init') {
          return Response.json({ ok: true });
        }
        if (path === '/api/context/semantic') {
          return Response.json({ context: 'codex semantic context', count: 1 });
        }
        if (path === '/api/sessions/observations') {
          return Response.json({ ok: true });
        }
        if (path === '/api/sessions/summarize') {
          return Response.json({ status: 'queued' });
        }

        return new Response('unexpected path', { status: 404 });
      },
    }));

    const tempDir = join(tmpdir(), `codex-hook-mainline-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
    const transcriptPath = join(tempDir, 'codex-session.jsonl');
    writeFileSync(
      transcriptPath,
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'Codex assistant final answer' }],
        },
      }) + '\n',
    );

    try {
      const { contextHandler } = await import('../../src/cli/handlers/context.js');
      const { sessionInitHandler } = await import('../../src/cli/handlers/session-init.js');
      const { observationHandler } = await import('../../src/cli/handlers/observation.js');
      const { summarizeHandler } = await import('../../src/cli/handlers/summarize.js');

      const baseInput = {
        sessionId: 'codex-session-1',
        cwd: tempDir,
        platform: 'codex-cli',
        transcriptPath,
      };

      const contextResult = await contextHandler.execute(baseInput);
      expect(contextResult.hookSpecificOutput).toEqual({
        hookEventName: 'SessionStart',
        additionalContext: 'codex startup context',
      });

      const sessionResult = await sessionInitHandler.execute({
        ...baseInput,
        prompt: 'Please recall relevant prior work for this Codex task.',
      });
      expect(sessionResult.hookSpecificOutput).toEqual({
        hookEventName: 'UserPromptSubmit',
        additionalContext: 'codex semantic context',
      });

      const observationResult = await observationHandler.execute({
        ...baseInput,
        toolName: 'Bash',
        toolUseId: 'call_bash_1',
        toolInput: { command: 'printf ok' },
        toolResponse: 'ok',
      });
      expect(observationResult.continue).toBe(true);

      const summarizeResult = await summarizeHandler.execute(baseInput);
      expect(summarizeResult.continue).toBe(true);
      expect(summarizeResult.exitCode).toBe(0);

      const initBody = JSON.parse(String(requests.find((r) => r.path === '/api/sessions/init')?.init?.body));
      expect(initBody.platformSource).toBe('codex');

      const observationBody = JSON.parse(String(requests.find((r) => r.path === '/api/sessions/observations')?.init?.body));
      expect(observationBody.platformSource).toBe('codex');
      expect(observationBody.tool_name).toBe('Bash');
      expect(observationBody.toolUseId).toBe('call_bash_1');

      const summarizeBody = JSON.parse(String(requests.find((r) => r.path === '/api/sessions/summarize')?.init?.body));
      expect(summarizeBody.platformSource).toBe('codex');
      expect(summarizeBody.last_assistant_message).toBe('Codex assistant final answer');
    } finally {
      if (previousSemanticInject === undefined) {
        delete process.env.CLAUDE_MEM_SEMANTIC_INJECT;
      } else {
        process.env.CLAUDE_MEM_SEMANTIC_INJECT = previousSemanticInject;
      }
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
