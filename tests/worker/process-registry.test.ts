import { describe, it, expect, beforeEach, afterEach, afterAll, mock } from 'bun:test';
import type { ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { createProcessRegistry, type ManagedProcessInfo } from '../../src/supervisor/process-registry.js';

const testSupervisorDir = mkdtempSync(path.join(tmpdir(), 'claude-mem-process-registry-test-'));
const testSupervisorRegistry = createProcessRegistry(path.join(testSupervisorDir, 'supervisor.json'));

mock.module('../../src/supervisor/index.js', () => ({
  getSupervisor: () => ({
    assertCanSpawn: () => {},
    registerProcess: (id: string, processInfo: ManagedProcessInfo, processRef?: ChildProcess) => {
      testSupervisorRegistry.register(id, processInfo, processRef);
    },
    unregisterProcess: (id: string) => {
      testSupervisorRegistry.unregister(id);
    },
    getRegistry: () => testSupervisorRegistry,
  }),
}));

afterAll(() => {
  rmSync(testSupervisorDir, { recursive: true, force: true });
});

import {
  registerProcess,
  unregisterProcess,
  getProcessBySession,
  getActiveCount,
  getActiveProcesses,
  waitForSlot,
  ensureProcessExit,
  shouldKillIdleDaemonChild,
} from '../../src/services/worker/ProcessRegistry.js';

/**
 * Create a mock ChildProcess that behaves like a real one for testing.
 * Supports exitCode, killed, kill(), and event emission.
 */
function createMockProcess(overrides: { exitCode?: number | null; killed?: boolean } = {}) {
  const emitter = new EventEmitter();
  const mock = Object.assign(emitter, {
    pid: Math.floor(Math.random() * 100000) + 1000,
    exitCode: overrides.exitCode ?? null,
    killed: overrides.killed ?? false,
    kill(signal?: string) {
      mock.killed = true;
      // Simulate async exit after kill
      setTimeout(() => {
        mock.exitCode = signal === 'SIGKILL' ? null : 0;
        mock.emit('exit', mock.exitCode, signal || 'SIGTERM');
      }, 10);
      return true;
    },
    stdin: null,
    stdout: null,
    stderr: null,
  });
  return mock;
}

// Helper to clear registry between tests by unregistering all
function clearRegistry() {
  for (const p of getActiveProcesses()) {
    unregisterProcess(p.pid);
  }
  testSupervisorRegistry.clear();
}

describe('ProcessRegistry', () => {
  beforeEach(() => {
    clearRegistry();
  });

  afterEach(() => {
    clearRegistry();
  });

  describe('registerProcess / unregisterProcess', () => {
    it('should register and track a process', () => {
      const proc = createMockProcess();
      registerProcess(proc.pid, 1, proc as any);
      expect(getActiveCount()).toBe(1);
      expect(getProcessBySession(1)).toBeDefined();
    });

    it('should unregister a process and free the slot', () => {
      const proc = createMockProcess();
      registerProcess(proc.pid, 1, proc as any);
      unregisterProcess(proc.pid);
      expect(getActiveCount()).toBe(0);
      expect(getProcessBySession(1)).toBeUndefined();
    });
  });

  describe('getProcessBySession', () => {
    it('should return undefined for unknown session', () => {
      expect(getProcessBySession(999)).toBeUndefined();
    });

    it('should find process by session ID', () => {
      const proc = createMockProcess();
      registerProcess(proc.pid, 42, proc as any);
      const found = getProcessBySession(42);
      expect(found).toBeDefined();
      expect(found!.pid).toBe(proc.pid);
    });
  });

  describe('waitForSlot', () => {
    it('should resolve immediately when under limit', async () => {
      await waitForSlot(2); // 0 processes, limit 2
      const proc = createMockProcess();
      registerProcess(proc.pid, 1, proc as any);
      unregisterProcess(proc.pid);
    });

    it('should wait until a slot opens', async () => {
      const proc1 = createMockProcess();
      const proc2 = createMockProcess();
      registerProcess(proc1.pid, 1, proc1 as any);
      registerProcess(proc2.pid, 2, proc2 as any);

      // Start waiting for slot (limit=2, both slots full)
      const waitPromise = waitForSlot(2, 5000);

      // Free a slot after 50ms
      setTimeout(() => unregisterProcess(proc1.pid), 50);

      await waitPromise; // Should resolve once slot freed
      const replacement = createMockProcess();
      registerProcess(replacement.pid, 3, replacement as any);
      expect(getActiveCount()).toBe(2);
      unregisterProcess(replacement.pid);
    });

    it('should throw on timeout when no slot opens', async () => {
      const proc1 = createMockProcess();
      const proc2 = createMockProcess();
      registerProcess(proc1.pid, 1, proc1 as any);
      registerProcess(proc2.pid, 2, proc2 as any);

      await expect(waitForSlot(2, 100)).rejects.toThrow('Timed out waiting for agent pool slot');
    });

    it('should throw when hard cap (10) is exceeded', async () => {
      // Register 10 processes to hit the hard cap
      const procs = [];
      for (let i = 0; i < 10; i++) {
        const proc = createMockProcess();
        registerProcess(proc.pid, i + 100, proc as any);
        procs.push(proc);
      }

      await expect(waitForSlot(20)).rejects.toThrow('Hard cap exceeded');
    });

    it('should not let new callers bypass an already-awakened waiter', async () => {
      const proc1 = createMockProcess();
      registerProcess(proc1.pid, 1, proc1 as any);

      let replacement: ReturnType<typeof createMockProcess> | undefined;
      const firstWaiter = waitForSlot(1, 500).then(() => {
        replacement = createMockProcess();
        registerProcess(replacement.pid, 101, replacement as any);
      });

      unregisterProcess(proc1.pid);

      const barger = waitForSlot(1, 75);

      await firstWaiter;

      await expect(barger).rejects.toThrow('Timed out waiting for agent pool slot');

      if (replacement) {
        unregisterProcess(replacement.pid);
      }
    });
  });

  describe('ensureProcessExit', () => {
    it('should unregister immediately if exitCode is set', async () => {
      const proc = createMockProcess({ exitCode: 0 });
      registerProcess(proc.pid, 1, proc as any);

      await ensureProcessExit({ pid: proc.pid, sessionDbId: 1, spawnedAt: Date.now(), process: proc as any });
      expect(getActiveCount()).toBe(0);
    });

    it('should NOT treat proc.killed as exited — must wait for actual exit', async () => {
      // This is the core bug fix: proc.killed=true but exitCode=null means NOT dead
      const proc = createMockProcess({ killed: true, exitCode: null });
      registerProcess(proc.pid, 1, proc as any);

      // Override kill to simulate SIGKILL + delayed exit
      proc.kill = (signal?: string) => {
        proc.killed = true;
        setTimeout(() => {
          proc.exitCode = 0;
          proc.emit('exit', 0, signal);
        }, 20);
        return true;
      };

      // ensureProcessExit should NOT short-circuit on proc.killed
      // It should wait for exit event or timeout, then escalate to SIGKILL
      const start = Date.now();
      await ensureProcessExit({ pid: proc.pid, sessionDbId: 1, spawnedAt: Date.now(), process: proc as any }, 100);
      expect(getActiveCount()).toBe(0);
    });

    it('should escalate to SIGKILL after timeout', async () => {
      const proc = createMockProcess();
      registerProcess(proc.pid, 1, proc as any);

      // Override kill: only respond to SIGKILL
      let sigkillSent = false;
      proc.kill = (signal?: string) => {
        proc.killed = true;
        if (signal === 'SIGKILL') {
          sigkillSent = true;
          setTimeout(() => {
            proc.exitCode = -1;
            proc.emit('exit', -1, 'SIGKILL');
          }, 10);
        }
        // Don't emit exit for non-SIGKILL signals (simulates stuck process)
        return true;
      };

      await ensureProcessExit({ pid: proc.pid, sessionDbId: 1, spawnedAt: Date.now(), process: proc as any }, 100);
      expect(sigkillSent).toBe(true);
      expect(getActiveCount()).toBe(0);
    });

    it('should unregister even if process ignores SIGKILL (after 1s timeout)', async () => {
      const proc = createMockProcess();
      registerProcess(proc.pid, 1, proc as any);

      // Override kill to never emit exit (completely stuck process)
      proc.kill = () => {
        proc.killed = true;
        return true;
      };

      const start = Date.now();
      await ensureProcessExit({ pid: proc.pid, sessionDbId: 1, spawnedAt: Date.now(), process: proc as any }, 100);
      const elapsed = Date.now() - start;

      // Should have waited ~100ms for graceful + ~1000ms for SIGKILL timeout
      expect(elapsed).toBeGreaterThan(90);
      // Process is unregistered regardless (safety net)
      expect(getActiveCount()).toBe(0);
    });
  });

  describe('idle daemon child cleanup policy', () => {
    it('should not kill a daemon child that is still registered to an active session', () => {
      const proc = createMockProcess();
      registerProcess(proc.pid, 450, proc as any);

      expect(shouldKillIdleDaemonChild({
        pid: proc.pid,
        ppid: process.pid,
        cpu: 0,
        idleMinutes: 10
      }, process.pid, new Set([450]))).toBe(false);
    });

    it('should not kill short-idle unregistered daemon children', () => {
      expect(shouldKillIdleDaemonChild({
        pid: 999_001,
        ppid: process.pid,
        cpu: 0,
        idleMinutes: 1
      }, process.pid, new Set())).toBe(false);
    });

    it('should allow killing an old idle unregistered daemon child', () => {
      expect(shouldKillIdleDaemonChild({
        pid: 999_002,
        ppid: process.pid,
        cpu: 0,
        idleMinutes: 10
      }, process.pid, new Set())).toBe(true);
    });
  });
});
