import { describe, expect, it } from 'bun:test';

import { parseSubagentNotifications } from '../../../src/shared/transcript-parser.js';
import { TranscriptEventProcessor } from '../../../src/services/transcripts/processor.js';
import { compileChildReceiptObservations } from '../../../src/services/context/ObservationCompiler.js';
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
  version: '0.5',
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
      match: { path: 'payload.role', equals: 'user' },
      action: 'user_message',
      fields: {
        message: 'payload.content[0].text'
      }
    }
  ]
};

const notificationText = [
  '<subagent_notification>',
  '{"agent_path":"019dbfc1-0a55-7672-ad2f-44b53d9e40d6","status":{"completed":"child finished one-line result"}}',
  '</subagent_notification>'
].join('\n');

describe('Codex subagent receipt ingestion', () => {
  it('parses the Codex host-max subagent notification tag without treating it as SubagentStop parity', () => {
    const [receipt] = parseSubagentNotifications(notificationText);

    expect(receipt).toEqual(expect.objectContaining({
      agentPath: '019dbfc1-0a55-7672-ad2f-44b53d9e40d6',
      childSessionId: '019dbfc1-0a55-7672-ad2f-44b53d9e40d6',
      terminalStatus: 'completed',
      terminalMessage: 'child finished one-line result',
      sourceTag: 'subagent_notification'
    }));
    expect(receipt.parityClaim).toBe('codex_host_max_degraded_receipt_not_subagentstop');
  });

  it('projects a no-wait subagent notification into a child_session receipt during the parent turn', async () => {
    const processor = new TranscriptEventProcessor();

    await processor.processEntry(
      { type: 'session_meta', payload: { id: 'parent-session', cwd: '/repo/workspace' } },
      watch,
      schema
    );
    const events = await processor.processEntry(
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: notificationText }]
        }
      },
      watch,
      schema,
      'parent-session'
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(expect.objectContaining({
      type: 'child_session',
      materialization: 'deferred',
      source: expect.objectContaining({
        rail: 'child',
        role: 'child_receipt',
        priority: 'sidecar',
        primaryRail: 'hooks'
      }),
      session: expect.objectContaining({
        id: 'parent-session',
        platformSource: 'codex',
        cwd: '/repo/workspace'
      }),
      payload: expect.objectContaining({
        childSessionId: '019dbfc1-0a55-7672-ad2f-44b53d9e40d6',
        agentId: '019dbfc1-0a55-7672-ad2f-44b53d9e40d6',
        agentType: 'codex-subagent',
        status: 'completed'
      }),
      metadata: expect.objectContaining({
        sourceTag: 'subagent_notification',
        noWaitIngestible: true,
        parityClaim: 'codex_host_max_degraded_receipt_not_subagentstop',
        terminalMessage: 'child finished one-line result'
      })
    }));
    expect(events[0].idempotencyKey).toBe(
      'codex:parent-session:child_session:019dbfc1-0a55-7672-ad2f-44b53d9e40d6:completed'
    );
  });

  it('compiles child_session receipts into child-terminal observations for context replay', async () => {
    const processor = new TranscriptEventProcessor();

    await processor.processEntry(
      { type: 'session_meta', payload: { id: 'parent-session', cwd: '/repo/workspace' } },
      watch,
      schema
    );
    const events = await processor.processEntry(
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: notificationText }]
        }
      },
      watch,
      schema,
      'parent-session'
    );

    const observations = compileChildReceiptObservations(events, {
      startId: 900,
      observedAtEpoch: 1_776_000_000_000
    });

    expect(observations).toHaveLength(1);
    expect(observations[0]).toEqual(expect.objectContaining({
      id: 900,
      memory_session_id: 'parent-session',
      platform_source: 'codex',
      type: 'child_terminal',
      title: 'Codex child completed: 019dbfc1-0a55-7672-ad2f-44b53d9e40d6',
      subtitle: 'Codex host-max degraded receipt; not SubagentStop parity',
      narrative: 'child finished one-line result',
      created_at_epoch: 1_776_000_000_000
    }));
    expect(JSON.parse(observations[0].concepts ?? '[]')).toEqual([
      'codex',
      'child-receipt',
      'subagent-notification',
      'host-max-degraded'
    ]);
  });
});
