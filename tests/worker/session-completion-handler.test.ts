import { describe, expect, it, mock } from 'bun:test';
import { SessionCompletionHandler } from '../../src/services/worker/session/SessionCompletionHandler.js';

describe('SessionCompletionHandler', () => {
  it('finalizes immediately without awaiting slow deleteSession cleanup', async () => {
    let deleteSessionResolve: (() => void) | null = null;

    const sessionStore = {
      getSessionById: mock(() => ({
        id: 42,
        status: 'active',
      })),
      markSessionCompleted: mock(() => {}),
    };

    const pendingStore = {
      getPendingCount: mock(() => 0),
      markAllSessionMessagesAbandoned: mock(() => 0),
    };

    const sessionManager = {
      getPendingMessageStore: mock(() => pendingStore),
      deleteSession: mock(
        () =>
          new Promise<void>((resolve) => {
            deleteSessionResolve = resolve;
          })
      ),
    };

    const eventBroadcaster = {
      broadcastSessionCompleted: mock(() => {}),
    };

    const dbManager = {
      getSessionStore: mock(() => sessionStore),
    };

    const handler = new SessionCompletionHandler(
      sessionManager as any,
      eventBroadcaster as any,
      dbManager as any
    );

    const result = await Promise.race([
      handler.completeByDbId(42).then(() => 'completed'),
      new Promise<string>((resolve) => setTimeout(() => resolve('timed_out'), 25)),
    ]);

    expect(result).toBe('completed');
    expect(sessionStore.markSessionCompleted).toHaveBeenCalledTimes(1);
    expect(eventBroadcaster.broadcastSessionCompleted).toHaveBeenCalledTimes(1);
    expect(sessionManager.deleteSession).toHaveBeenCalledTimes(1);

    deleteSessionResolve?.();
  });

  it('defers completion instead of abandoning queued observations', async () => {
    const sessionStore = {
      getSessionById: mock(() => ({
        id: 42,
        status: 'active',
      })),
      markSessionCompleted: mock(() => {}),
    };

    const pendingStore = {
      getPendingCount: mock(() => 1),
      markAllSessionMessagesAbandoned: mock(() => 1),
    };

    const sessionManager = {
      getPendingMessageStore: mock(() => pendingStore),
      deleteSession: mock(() => Promise.resolve()),
    };

    const eventBroadcaster = {
      broadcastSessionCompleted: mock(() => {}),
    };

    const dbManager = {
      getSessionStore: mock(() => sessionStore),
    };

    const handler = new SessionCompletionHandler(
      sessionManager as any,
      eventBroadcaster as any,
      dbManager as any
    );

    const result = await handler.completeByDbId(42);

    expect(result).toEqual({ completed: false, reason: 'pending_work', queueDepth: 1 });
    expect(sessionStore.markSessionCompleted).not.toHaveBeenCalled();
    expect(pendingStore.markAllSessionMessagesAbandoned).not.toHaveBeenCalled();
    expect(eventBroadcaster.broadcastSessionCompleted).not.toHaveBeenCalled();
    expect(sessionManager.deleteSession).not.toHaveBeenCalled();
  });
});
