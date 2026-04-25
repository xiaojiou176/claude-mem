/**
 * Runtime recovery reliability tests for WorkerService pending queue startup.
 *
 * These tests intentionally call WorkerService.processPendingQueues() through a
 * narrow fake service object. The behavior under test is owned by
 * worker-service.ts: stale active session cleanup, recovery eligibility, and
 * ensuring old pending/processing work is not revived during startup recovery.
 */

import { afterEach, beforeEach, describe, expect, setSystemTime, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { WorkerService } from '../../../src/services/worker-service.js';

const MAX_RECOVERY_SESSION_AGE_MS = 4 * 60 * 60 * 1000;
const STALE_ACTIVE_NO_QUEUE_SESSION_AGE_MS = 15 * 60 * 1000;

type ProcessPendingQueues = (sessionLimit?: number) => Promise<{
  totalPendingSessions: number;
  sessionsStarted: number;
  sessionsSkipped: number;
  startedSessionIds: number[];
}>;

interface SessionRow {
  status: string;
  completed_at_epoch: number | null;
}

interface PendingRow {
  status: string;
  failed_at_epoch: number | null;
}

describe('WorkerService runtime recovery reliability', () => {
  let db: Database;
  let startedSessionIds: number[];
  let activeSessions: Map<number, { sessionDbId: number; generatorPromise: Promise<void> | null }>;

  beforeEach(() => {
    setSystemTime();
    db = new Database(':memory:');
    startedSessionIds = [];
    activeSessions = new Map();

    db.run(`
      CREATE TABLE sdk_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content_session_id TEXT NOT NULL,
        memory_session_id TEXT,
        project TEXT NOT NULL,
        platform_source TEXT DEFAULT 'claude',
        user_prompt TEXT NOT NULL,
        custom_title TEXT,
        started_at TEXT NOT NULL,
        started_at_epoch INTEGER NOT NULL,
        completed_at TEXT,
        completed_at_epoch INTEGER,
        status TEXT NOT NULL
      )
    `);

    db.run(`
      CREATE TABLE pending_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_db_id INTEGER NOT NULL,
        content_session_id TEXT NOT NULL,
        message_type TEXT NOT NULL,
        tool_name TEXT,
        tool_input TEXT,
        tool_response TEXT,
        cwd TEXT,
        last_assistant_message TEXT,
        prompt_number INTEGER,
        status TEXT NOT NULL,
        retry_count INTEGER DEFAULT 0,
        created_at_epoch INTEGER NOT NULL,
        started_processing_at_epoch INTEGER,
        completed_at_epoch INTEGER,
        failed_at_epoch INTEGER,
        agent_type TEXT,
        agent_id TEXT,
        tool_use_id TEXT
      )
    `);
  });

  afterEach(() => {
    setSystemTime();
    db.close();
  });

  function insertSession(startedAtEpoch: number, status = 'active'): number {
    const result = db.prepare(`
      INSERT INTO sdk_sessions (
        content_session_id, memory_session_id, project, platform_source,
        user_prompt, started_at, started_at_epoch, status
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      `content-${startedAtEpoch}`,
      null,
      'runtime-reliability',
      'claude',
      'test prompt',
      new Date(startedAtEpoch).toISOString(),
      startedAtEpoch,
      status
    );

    return Number(result.lastInsertRowid);
  }

  function insertPendingMessage(sessionDbId: number, status: 'pending' | 'processing'): number {
    const now = Date.now();
    const result = db.prepare(`
      INSERT INTO pending_messages (
        session_db_id, content_session_id, message_type, tool_name, status,
        retry_count, created_at_epoch, started_processing_at_epoch
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      sessionDbId,
      `content-${sessionDbId}`,
      'observation',
      'Bash',
      status,
      0,
      now,
      status === 'processing' ? now - 10 * 60 * 1000 : null
    );

    return Number(result.lastInsertRowid);
  }

  function createServiceHarness() {
    return Object.assign(Object.create(WorkerService.prototype), {
      dbManager: {
        getSessionStore: () => ({ db }),
      },
      sessionManager: {
        getSession: (sessionDbId: number) => activeSessions.get(sessionDbId),
        initializeSession: (sessionDbId: number) => ({ sessionDbId }),
      },
      startSessionProcessor: (session: { sessionDbId: number }, _source: string) => {
        startedSessionIds.push(session.sessionDbId);
      },
    });
  }

  async function processPendingQueues(sessionLimit = 10) {
    const method = WorkerService.prototype.processPendingQueues as ProcessPendingQueues;
    return method.call(createServiceHarness(), sessionLimit);
  }

  function readSession(sessionDbId: number): SessionRow {
    return db.prepare(`
      SELECT status, completed_at_epoch FROM sdk_sessions WHERE id = ?
    `).get(sessionDbId) as SessionRow;
  }

  function readPendingMessage(messageId: number): PendingRow {
    return db.prepare(`
      SELECT status, failed_at_epoch FROM pending_messages WHERE id = ?
    `).get(messageId) as PendingRow;
  }

  test('startup recovery fails active sessions older than the 4h wall-clock limit instead of reviving them', async () => {
    const staleSessionId = insertSession(Date.now() - MAX_RECOVERY_SESSION_AGE_MS - 1);
    const messageId = insertPendingMessage(staleSessionId, 'pending');

    const result = await processPendingQueues(50);

    expect(result.sessionsStarted).toBe(0);
    expect(result.startedSessionIds).toEqual([]);
    expect(startedSessionIds).toEqual([]);
    expect(result.sessionsSkipped).toBe(0);

    const session = readSession(staleSessionId);
    expect(session.status).toBe('failed');
    expect(session.completed_at_epoch).toBeGreaterThan(0);

    const message = readPendingMessage(messageId);
    expect(message.status).toBe('failed');
    expect(message.failed_at_epoch).toBeGreaterThan(0);
  });

  test('startup cleanup fails processing messages from stale active sessions so they cannot re-enter recovery', async () => {
    const staleSessionId = insertSession(Date.now() - MAX_RECOVERY_SESSION_AGE_MS - 60_000);
    const messageId = insertPendingMessage(staleSessionId, 'processing');

    const result = await processPendingQueues(50);

    expect(result.sessionsStarted).toBe(0);
    expect(result.startedSessionIds).toEqual([]);
    expect(startedSessionIds).toEqual([]);
    expect(result.sessionsSkipped).toBe(0);

    const session = readSession(staleSessionId);
    expect(session.status).toBe('failed');

    const message = readPendingMessage(messageId);
    expect(message.status).toBe('failed');
    expect(message.failed_at_epoch).toBeGreaterThan(0);
  });

  test('startup recovery still starts fresh active sessions with pending work', async () => {
    const freshSessionId = insertSession(Date.now() - 5 * 60 * 1000);
    const messageId = insertPendingMessage(freshSessionId, 'pending');

    const result = await processPendingQueues(50);

    expect(result.sessionsStarted).toBe(1);
    expect(result.startedSessionIds).toEqual([freshSessionId]);
    expect(startedSessionIds).toEqual([freshSessionId]);
    expect(result.sessionsSkipped).toBe(0);

    const session = readSession(freshSessionId);
    expect(session.status).toBe('active');

    const message = readPendingMessage(messageId);
    expect(message.status).toBe('pending');
    expect(message.failed_at_epoch).toBeNull();
  });

  test('startup recovery does not revive non-active sessions even when stale pending work remains', async () => {
    const failedSessionId = insertSession(Date.now() - 5 * 60 * 1000, 'failed');
    const messageId = insertPendingMessage(failedSessionId, 'pending');

    const result = await processPendingQueues(50);

    expect(result.sessionsStarted).toBe(0);
    expect(result.startedSessionIds).toEqual([]);
    expect(startedSessionIds).toEqual([]);
    expect(result.sessionsSkipped).toBe(1);

    const session = readSession(failedSessionId);
    expect(session.status).toBe('failed');

    const message = readPendingMessage(messageId);
    expect(message.status).toBe('failed');
    expect(message.failed_at_epoch).toBeGreaterThan(0);
  });

  test('boot janitor marks stale active sessions with no active queue as failed', async () => {
    const staleSessionId = insertSession(Date.now() - STALE_ACTIVE_NO_QUEUE_SESSION_AGE_MS - 60_000);

    const result = await processPendingQueues(50);

    expect(result.sessionsStarted).toBe(0);
    expect(result.startedSessionIds).toEqual([]);
    expect(startedSessionIds).toEqual([]);

    const session = readSession(staleSessionId);
    expect(session.status).toBe('failed');
    expect(session.completed_at_epoch).toBeGreaterThan(0);
  });

  test('boot janitor marks high-age no-queue active sessions before the 4h recovery limit', async () => {
    const liveSymptomAgeMs = 3.8 * 60 * 60 * 1000;
    const staleSessionId = insertSession(Date.now() - liveSymptomAgeMs);

    const result = await processPendingQueues(50);

    expect(result.sessionsStarted).toBe(0);
    expect(result.startedSessionIds).toEqual([]);
    expect(startedSessionIds).toEqual([]);

    const session = readSession(staleSessionId);
    expect(session.status).toBe('failed');
    expect(session.completed_at_epoch).toBeGreaterThan(0);
  });

  test('boot janitor keeps stale active sessions with in-memory generator ownership', async () => {
    const staleSessionId = insertSession(Date.now() - STALE_ACTIVE_NO_QUEUE_SESSION_AGE_MS - 60_000);
    activeSessions.set(staleSessionId, {
      sessionDbId: staleSessionId,
      generatorPromise: new Promise(() => {}),
    });

    const result = await processPendingQueues(50);

    expect(result.sessionsStarted).toBe(0);
    expect(result.startedSessionIds).toEqual([]);
    expect(startedSessionIds).toEqual([]);

    const session = readSession(staleSessionId);
    expect(session.status).toBe('active');
    expect(session.completed_at_epoch).toBeNull();
  });

  test('boot janitor keeps stale active sessions with any in-memory session ownership', async () => {
    const staleSessionId = insertSession(Date.now() - STALE_ACTIVE_NO_QUEUE_SESSION_AGE_MS - 60_000);
    activeSessions.set(staleSessionId, {
      sessionDbId: staleSessionId,
      generatorPromise: null,
    });

    const result = await processPendingQueues(50);

    expect(result.sessionsStarted).toBe(0);
    expect(result.startedSessionIds).toEqual([]);
    expect(startedSessionIds).toEqual([]);

    const session = readSession(staleSessionId);
    expect(session.status).toBe('active');
    expect(session.completed_at_epoch).toBeNull();
  });

  test('boot janitor keeps fresh active sessions with no active queue', async () => {
    const freshSessionId = insertSession(Date.now() - 5 * 60 * 1000);

    const result = await processPendingQueues(50);

    expect(result.sessionsStarted).toBe(0);
    expect(result.startedSessionIds).toEqual([]);
    expect(startedSessionIds).toEqual([]);

    const session = readSession(freshSessionId);
    expect(session.status).toBe('active');
    expect(session.completed_at_epoch).toBeNull();
  });
});
