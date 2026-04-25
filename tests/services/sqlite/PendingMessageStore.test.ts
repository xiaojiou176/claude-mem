import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { ClaudeMemDatabase } from '../../../src/services/sqlite/Database.js';
import { PendingMessageStore } from '../../../src/services/sqlite/PendingMessageStore.js';
import { createSDKSession } from '../../../src/services/sqlite/Sessions.js';
import type { PendingMessage } from '../../../src/services/worker-types.js';
import type { Database } from 'bun:sqlite';

describe('PendingMessageStore - Self-Healing claimNextMessage', () => {
  let db: Database;
  let store: PendingMessageStore;
  let sessionDbId: number;
  const CONTENT_SESSION_ID = 'test-self-heal';

  beforeEach(() => {
    db = new ClaudeMemDatabase(':memory:').db;
    store = new PendingMessageStore(db, 3);
    sessionDbId = createSDKSession(db, CONTENT_SESSION_ID, 'test-project', 'Test prompt');
  });

  afterEach(() => {
    db.close();
  });

  function enqueueMessage(overrides: Partial<PendingMessage> = {}): number {
    const message: PendingMessage & { toolUseId: string } = {
      type: 'observation',
      tool_name: 'TestTool',
      tool_input: { test: 'input' },
      tool_response: { test: 'response' },
      prompt_number: 1,
      ...overrides,
    };
    return store.enqueue(sessionDbId, CONTENT_SESSION_ID, message);
  }

  /**
   * Helper to simulate a stuck processing message by directly updating the DB
   * to set started_processing_at_epoch to a time in the past (>60s ago)
   */
  function makeMessageStaleProcessing(messageId: number): void {
    const staleTimestamp = Date.now() - 120_000; // 2 minutes ago (well past 60s threshold)
    db.run(
      `UPDATE pending_messages SET status = 'processing', started_processing_at_epoch = ? WHERE id = ?`,
      [staleTimestamp, messageId]
    );
  }

  test('stuck processing messages are recovered on next claim', () => {
    // Enqueue a message and make it stuck in processing
    const msgId = enqueueMessage();
    makeMessageStaleProcessing(msgId);

    // Verify it's stuck (status = processing)
    const beforeClaim = db.query('SELECT status FROM pending_messages WHERE id = ?').get(msgId) as { status: string };
    expect(beforeClaim.status).toBe('processing');

    // claimNextMessage should self-heal: reset the stuck message, then claim it
    const claimed = store.claimNextMessage(sessionDbId);

    expect(claimed).not.toBeNull();
    expect(claimed!.id).toBe(msgId);
    // It should now be in 'processing' status again (freshly claimed)
    const afterClaim = db.query('SELECT status FROM pending_messages WHERE id = ?').get(msgId) as { status: string };
    expect(afterClaim.status).toBe('processing');
  });

  test('actively processing messages are NOT recovered', () => {
    // Enqueue two messages
    const activeId = enqueueMessage();
    const pendingId = enqueueMessage();

    // Make the first one actively processing (recent timestamp, NOT stale)
    const recentTimestamp = Date.now() - 5_000; // 5 seconds ago (well within 60s threshold)
    db.run(
      `UPDATE pending_messages SET status = 'processing', started_processing_at_epoch = ? WHERE id = ?`,
      [recentTimestamp, activeId]
    );

    // claimNextMessage should NOT reset the active one — should claim the pending one instead
    const claimed = store.claimNextMessage(sessionDbId);

    expect(claimed).not.toBeNull();
    expect(claimed!.id).toBe(pendingId);

    // The active message should still be processing
    const activeMsg = db.query('SELECT status FROM pending_messages WHERE id = ?').get(activeId) as { status: string };
    expect(activeMsg.status).toBe('processing');
  });

  test('recovery and claim is atomic within single call', () => {
    // Enqueue three messages
    const stuckId = enqueueMessage();
    const pendingId1 = enqueueMessage();
    const pendingId2 = enqueueMessage();

    // Make the first one stuck
    makeMessageStaleProcessing(stuckId);

    // Single claimNextMessage should reset stuck AND claim oldest pending (which is the reset stuck one)
    const claimed = store.claimNextMessage(sessionDbId);

    expect(claimed).not.toBeNull();
    // The stuck message was reset to pending, and being oldest, it gets claimed
    expect(claimed!.id).toBe(stuckId);

    // The other two should still be pending
    const msg1 = db.query('SELECT status FROM pending_messages WHERE id = ?').get(pendingId1) as { status: string };
    const msg2 = db.query('SELECT status FROM pending_messages WHERE id = ?').get(pendingId2) as { status: string };
    expect(msg1.status).toBe('pending');
    expect(msg2.status).toBe('pending');
  });

  test('no messages returns null without error', () => {
    const claimed = store.claimNextMessage(sessionDbId);
    expect(claimed).toBeNull();
  });

  test('self-healing only affects the specified session', () => {
    // Create a second session
    const session2Id = createSDKSession(db, 'other-session', 'test-project', 'Test');

    // Enqueue and make stuck in session 1
    const stuckInSession1 = enqueueMessage();
    makeMessageStaleProcessing(stuckInSession1);

    // Enqueue in session 2
    const msg: PendingMessage = {
      type: 'observation',
      tool_name: 'TestTool',
      tool_input: { test: 'input' },
      tool_response: { test: 'response' },
      prompt_number: 1,
    };
    const session2MsgId = store.enqueue(session2Id, 'other-session', msg);
    makeMessageStaleProcessing(session2MsgId);

    // Claim for session 2 — should only heal session 2's stuck message
    const claimed = store.claimNextMessage(session2Id);
    expect(claimed).not.toBeNull();
    expect(claimed!.id).toBe(session2MsgId);

    // Session 1's stuck message should still be stuck (not healed by session 2's claim)
    const session1Msg = db.query('SELECT status FROM pending_messages WHERE id = ?').get(stuckInSession1) as { status: string };
    expect(session1Msg.status).toBe('processing');
  });

  test('resetStaleProcessingMessages recovers processing rows with missing start timestamp', () => {
    const msgId = enqueueMessage();
    db.run(
      `UPDATE pending_messages SET status = 'processing', started_processing_at_epoch = NULL WHERE id = ?`,
      [msgId]
    );

    const resetCount = store.resetStaleProcessingMessages(60_000);

    expect(resetCount).toBe(1);
    const row = db.query('SELECT status, started_processing_at_epoch FROM pending_messages WHERE id = ?').get(msgId) as {
      status: string;
      started_processing_at_epoch: number | null;
    };
    expect(row.status).toBe('pending');
    expect(row.started_processing_at_epoch).toBeNull();
  });

  test('getSessionsWithPendingMessages resets stale processing rows before reporting recoverable sessions', () => {
    const msgId = enqueueMessage();
    db.run(
      `UPDATE pending_messages SET status = 'processing', started_processing_at_epoch = ? WHERE id = ?`,
      [Date.now() - 10 * 60_000, msgId]
    );

    const sessions = store.getSessionsWithPendingMessages();

    expect(sessions).toContain(sessionDbId);
    const row = db.query('SELECT status, started_processing_at_epoch FROM pending_messages WHERE id = ?').get(msgId) as {
      status: string;
      started_processing_at_epoch: number | null;
    };
    expect(row.status).toBe('pending');
    expect(row.started_processing_at_epoch).toBeNull();
  });

  test('getSessionsWithPendingMessages fails processing rows owned by non-active sessions', () => {
    const msgId = enqueueMessage();
    db.run(
      `UPDATE pending_messages SET status = 'processing', started_processing_at_epoch = ? WHERE id = ?`,
      [Date.now() - 10 * 60_000, msgId]
    );
    db.run(
      `UPDATE sdk_sessions SET status = 'completed', completed_at_epoch = ? WHERE id = ?`,
      [Date.now(), sessionDbId]
    );

    const sessions = store.getSessionsWithPendingMessages();

    expect(sessions).not.toContain(sessionDbId);
    const row = db.query('SELECT status, failed_at_epoch FROM pending_messages WHERE id = ?').get(msgId) as {
      status: string;
      failed_at_epoch: number | null;
    };
    expect(row.status).toBe('failed');
    expect(row.failed_at_epoch).toBeGreaterThan(0);
  });

  test('detects duplicate active observation payloads persisted before a worker restart', () => {
    const message: PendingMessage = {
      type: 'observation',
      tool_name: 'Bash',
      tool_input: { command: 'printf ok' },
      tool_response: { output: 'ok' },
      prompt_number: 3,
      cwd: '/repo',
      agentId: 'agent-1',
      agentType: 'implementation-worker',
      toolUseId: 'call_bash_restart_safe',
    };
    store.enqueue(sessionDbId, CONTENT_SESSION_ID, message);

    expect(store.hasActiveDuplicateObservation(sessionDbId, message)).toBe(true);
    expect(store.hasActiveDuplicateObservation(sessionDbId, {
      ...message,
      toolUseId: 'call_bash_restart_safe_new',
    })).toBe(false);

    const toolUseIdlessMessage: PendingMessage = {
      type: 'observation',
      tool_name: 'Bash',
      tool_input: { command: 'printf ok' },
      tool_response: { output: 'different' },
      prompt_number: 3,
      cwd: '/repo',
      agentId: 'agent-1',
      agentType: 'implementation-worker',
    };
    expect(store.hasActiveDuplicateObservation(sessionDbId, toolUseIdlessMessage)).toBe(false);

    store.enqueue(sessionDbId, CONTENT_SESSION_ID, toolUseIdlessMessage);
    expect(store.hasActiveDuplicateObservation(sessionDbId, toolUseIdlessMessage)).toBe(true);
  });

  test('counts active observation backlog for a single tool family only', () => {
    enqueueMessage({ tool_name: 'Bash' });
    enqueueMessage({ tool_name: 'Bash' });
    const processedId = enqueueMessage({ tool_name: 'Bash' });
    enqueueMessage({ tool_name: 'Read' });
    db.run('UPDATE pending_messages SET status = ? WHERE id = ?', ['failed', processedId]);

    expect(store.getPendingObservationToolCount(sessionDbId, 'Bash')).toBe(2);
    expect(store.getPendingObservationToolCount(sessionDbId, 'Read')).toBe(1);
  });
});
