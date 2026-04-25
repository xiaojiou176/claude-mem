import { describe, expect, it } from 'bun:test';

import { TranscriptEventProcessor } from '../../src/services/transcripts/processor.js';
import type { TranscriptSchema, WatchTarget } from '../../src/services/transcripts/types.js';

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
      name: 'assistant-message',
      match: { path: 'payload.role', equals: 'assistant' },
      action: 'assistant_message',
      fields: {
        message: 'payload.content[0].text'
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

const watch: WatchTarget = {
  name: 'codex',
  path: '~/.codex/sessions/**/*.jsonl',
  schema: 'codex',
  workspace: '/tmp/codex-spikes/subagent-matrix',
  project: 'subagent-matrix'
};

describe('Codex subagent receipt e2e transcript replay', () => {
  it('ingests a no-wait child completion notice before any parent session_end event exists', async () => {
    const processor = new TranscriptEventProcessor();
    const transcriptEntries = [
      { type: 'session_meta', payload: { id: '019dbfc0-parent', cwd: '/tmp/codex-spikes/subagent-matrix' } },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'child launched; not waiting yet' }]
        }
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{
            type: 'input_text',
            text: [
              '<subagent_notification>',
              '{"agent_path":"019dbfc1-child","status":{"completed":"one-line child result"}}',
              '</subagent_notification>'
            ].join('\n')
          }]
        }
      },
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'receipt consumed by parent' }]
        }
      }
    ];

    const emitted = [];
    for (const entry of transcriptEntries) {
      emitted.push(...await processor.processEntry(entry, watch, schema, '019dbfc0-parent'));
    }

    const childReceipt = emitted.find(event => (event as any).type === 'child_session');
    expect(childReceipt).toBeDefined();
    expect(childReceipt).toEqual(expect.objectContaining({
      payload: expect.objectContaining({
        childSessionId: '019dbfc1-child',
        status: 'completed'
      }),
      metadata: expect.objectContaining({
        noWaitIngestible: true,
        terminalMessage: 'one-line child result'
      })
    }));
    expect(emitted.map(event => event.type)).toEqual([
      'session_context',
      'assistant_message',
      'child_session',
      'assistant_message'
    ]);
  });
});
