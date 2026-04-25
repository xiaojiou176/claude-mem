import { defineCanonicalEvent } from './CanonicalEvent.js';
import type {
  CanonicalEvent,
  CanonicalEventSession,
  ChildSessionPayload,
} from './CanonicalEvent.js';
import type { ParsedSubagentNotification } from '../../shared/transcript-parser.js';

export interface SubagentReceiptProjectionInput {
  parentSession: CanonicalEventSession;
  receipts: ParsedSubagentNotification[];
  observedAt?: string;
}

export type SubagentReceiptEvent = CanonicalEvent<'child_session'>;

function createIdempotencyKey(parentSessionId: string, receipt: ParsedSubagentNotification): string {
  return `codex:${parentSessionId}:child_session:${receipt.childSessionId}:${receipt.terminalStatus}`;
}

function createPayload(receipt: ParsedSubagentNotification): ChildSessionPayload {
  return {
    childSessionId: receipt.childSessionId,
    agentId: receipt.agentPath,
    agentType: 'codex-subagent',
    status: receipt.terminalStatus
  };
}

export function projectSubagentReceipts(input: SubagentReceiptProjectionInput): SubagentReceiptEvent[] {
  return input.receipts.map(receipt => defineCanonicalEvent({
    idempotencyKey: createIdempotencyKey(input.parentSession.id, receipt),
    type: 'child_session',
    source: {
      rail: 'child',
      role: 'child_receipt',
      priority: 'sidecar',
      primaryRail: 'hooks',
      adapter: 'codex-subagent-notification'
    },
    session: {
      ...input.parentSession,
      parentSessionId: input.parentSession.parentSessionId
    },
    materialization: 'deferred',
    payload: createPayload(receipt),
    observedAt: input.observedAt,
    links: {
      parentEventId: `codex:${input.parentSession.id}:parent_thread`,
      relatedTranscriptOffset: undefined
    },
    metadata: {
      sourceTag: receipt.sourceTag,
      noWaitIngestible: true,
      parityClaim: receipt.parityClaim,
      terminalMessage: receipt.terminalMessage,
      rawStatus: receipt.rawStatus,
      childAgentPath: receipt.agentPath,
      receiptContract: 'parent_thread_id + child_agent_path + terminal_status'
    }
  }));
}
