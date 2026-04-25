/**
 * Tests for hook-command error classifier
 *
 * Validates that isWorkerUnavailableError correctly distinguishes between:
 * - Transport failures (ECONNREFUSED, etc.) → true (graceful degradation)
 * - Server errors (5xx) → true (graceful degradation)
 * - Client errors (4xx) → false (handler bug, blocking)
 * - Programming errors (TypeError, etc.) → false (code bug, blocking)
 */
import { describe, it, expect } from 'bun:test';
import { isWorkerUnavailableError, resolveHookEvent } from '../src/cli/hook-command.js';
import { codexCliAdapter } from '../src/cli/adapters/codex-cli.js';
import { geminiCliAdapter } from '../src/cli/adapters/gemini-cli.js';

describe('resolveHookEvent', () => {
  it('should map Codex native hook names into the existing hook-command mainline', () => {
    expect(resolveHookEvent('codex', 'SessionStart')).toBe('context');
    expect(resolveHookEvent('codex', 'UserPromptSubmit')).toBe('session-init');
    expect(resolveHookEvent('codex', 'PostToolUse')).toBe('observation');
    expect(resolveHookEvent('codex', 'Stop')).toBe('summarize');
  });

  it('should preserve existing internal event names and other platform behavior', () => {
    expect(resolveHookEvent('codex', 'context')).toBe('context');
    expect(resolveHookEvent('claude-code', 'SessionStart')).toBe('SessionStart');
    expect(resolveHookEvent('raw', 'PostToolUse')).toBe('PostToolUse');
  });
});

describe('Codex PostToolUse safety normalization', () => {
  it('should promote tool_use_id to a stable first-class identity for observation accounting', () => {
    const input = codexCliAdapter.normalizeInput({
      session_id: 'codex-session-1',
      cwd: '/repo',
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'printf ok' },
      tool_response: 'ok',
      tool_use_id: 'call_bash_123',
    });

    expect(input.toolUseId).toBe('call_bash_123');
    expect(input.metadata?.tool_use_id).toBe('call_bash_123');
  });

  it('should omit unsupported suppressOutput from Codex hook output while preserving context fields', () => {
    const output = codexCliAdapter.formatOutput({
      continue: true,
      suppressOutput: true,
      exitCode: 0,
      systemMessage: '\u001b[31mredacted status\u001b[0m',
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: 'codex observation context',
      },
    }) as Record<string, unknown>;

    expect(output).toEqual({
      continue: true,
      systemMessage: 'redacted status',
      additionalContext: 'codex observation context',
    });
    expect('suppressOutput' in output).toBe(false);
    expect('exitCode' in output).toBe(false);
    expect('status' in output).toBe(false);
  });

  it('should keep suppressOutput support in non-Codex adapters that own that contract', () => {
    const output = geminiCliAdapter.formatOutput({
      continue: true,
      suppressOutput: true,
    }) as Record<string, unknown>;

    expect(output).toMatchObject({
      continue: true,
      suppressOutput: true,
    });
  });
});

describe('isWorkerUnavailableError', () => {
  describe('transport failures → true (graceful)', () => {
    it('should classify ECONNREFUSED as worker unavailable', () => {
      const error = new Error('connect ECONNREFUSED 127.0.0.1:37777');
      expect(isWorkerUnavailableError(error)).toBe(true);
    });

    it('should classify ECONNRESET as worker unavailable', () => {
      const error = new Error('socket hang up ECONNRESET');
      expect(isWorkerUnavailableError(error)).toBe(true);
    });

    it('should classify EPIPE as worker unavailable', () => {
      const error = new Error('write EPIPE');
      expect(isWorkerUnavailableError(error)).toBe(true);
    });

    it('should classify ETIMEDOUT as worker unavailable', () => {
      const error = new Error('connect ETIMEDOUT 127.0.0.1:37777');
      expect(isWorkerUnavailableError(error)).toBe(true);
    });

    it('should classify "fetch failed" as worker unavailable', () => {
      const error = new TypeError('fetch failed');
      expect(isWorkerUnavailableError(error)).toBe(true);
    });

    it('should classify "Unable to connect" as worker unavailable', () => {
      const error = new Error('Unable to connect to server');
      expect(isWorkerUnavailableError(error)).toBe(true);
    });

    it('should classify ENOTFOUND as worker unavailable', () => {
      const error = new Error('getaddrinfo ENOTFOUND localhost');
      expect(isWorkerUnavailableError(error)).toBe(true);
    });

    it('should classify "socket hang up" as worker unavailable', () => {
      const error = new Error('socket hang up');
      expect(isWorkerUnavailableError(error)).toBe(true);
    });

    it('should classify ECONNABORTED as worker unavailable', () => {
      const error = new Error('ECONNABORTED');
      expect(isWorkerUnavailableError(error)).toBe(true);
    });
  });

  describe('timeout errors → true (graceful)', () => {
    it('should classify "timed out" as worker unavailable', () => {
      const error = new Error('Request timed out after 3000ms');
      expect(isWorkerUnavailableError(error)).toBe(true);
    });

    it('should classify "timeout" as worker unavailable', () => {
      const error = new Error('Connection timeout');
      expect(isWorkerUnavailableError(error)).toBe(true);
    });
  });

  describe('HTTP 5xx server errors → true (graceful)', () => {
    it('should classify 500 status as worker unavailable', () => {
      const error = new Error('Context generation failed: 500');
      expect(isWorkerUnavailableError(error)).toBe(true);
    });

    it('should classify 502 status as worker unavailable', () => {
      const error = new Error('Observation storage failed: 502');
      expect(isWorkerUnavailableError(error)).toBe(true);
    });

    it('should classify 503 status as worker unavailable', () => {
      const error = new Error('Request failed: 503');
      expect(isWorkerUnavailableError(error)).toBe(true);
    });

    it('should classify "status: 500" format as worker unavailable', () => {
      const error = new Error('HTTP error status: 500');
      expect(isWorkerUnavailableError(error)).toBe(true);
    });
  });

  describe('HTTP 429 rate limit → true (graceful)', () => {
    it('should classify 429 as worker unavailable (rate limit is transient)', () => {
      const error = new Error('Request failed: 429');
      expect(isWorkerUnavailableError(error)).toBe(true);
    });

    it('should classify "status: 429" format as worker unavailable', () => {
      const error = new Error('HTTP error status: 429');
      expect(isWorkerUnavailableError(error)).toBe(true);
    });
  });

  describe('HTTP 4xx client errors → false (blocking)', () => {
    it('should NOT classify 400 Bad Request as worker unavailable', () => {
      const error = new Error('Request failed: 400');
      expect(isWorkerUnavailableError(error)).toBe(false);
    });

    it('should NOT classify 404 Not Found as worker unavailable', () => {
      const error = new Error('Observation storage failed: 404');
      expect(isWorkerUnavailableError(error)).toBe(false);
    });

    it('should NOT classify 422 Validation Error as worker unavailable', () => {
      const error = new Error('Request failed: 422');
      expect(isWorkerUnavailableError(error)).toBe(false);
    });

    it('should NOT classify "status: 400" format as worker unavailable', () => {
      const error = new Error('HTTP error status: 400');
      expect(isWorkerUnavailableError(error)).toBe(false);
    });
  });

  describe('programming errors → false (blocking)', () => {
    it('should NOT classify TypeError as worker unavailable', () => {
      const error = new TypeError('Cannot read properties of undefined');
      // Note: TypeError with "fetch failed" IS classified as unavailable (transport layer)
      // But generic TypeErrors are NOT
      expect(isWorkerUnavailableError(new TypeError('Cannot read properties of undefined'))).toBe(false);
    });

    it('should NOT classify ReferenceError as worker unavailable', () => {
      const error = new ReferenceError('foo is not defined');
      expect(isWorkerUnavailableError(error)).toBe(false);
    });

    it('should NOT classify SyntaxError as worker unavailable', () => {
      const error = new SyntaxError('Unexpected token');
      expect(isWorkerUnavailableError(error)).toBe(false);
    });
  });

  describe('unknown errors → false (blocking, conservative)', () => {
    it('should NOT classify generic Error as worker unavailable', () => {
      const error = new Error('Something unexpected happened');
      expect(isWorkerUnavailableError(error)).toBe(false);
    });

    it('should handle string errors', () => {
      expect(isWorkerUnavailableError('ECONNREFUSED')).toBe(true);
      expect(isWorkerUnavailableError('random error')).toBe(false);
    });

    it('should handle null/undefined errors', () => {
      expect(isWorkerUnavailableError(null)).toBe(false);
      expect(isWorkerUnavailableError(undefined)).toBe(false);
    });
  });
});
