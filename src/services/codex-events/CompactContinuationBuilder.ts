import {
  defineCanonicalEvent,
  type CanonicalEvent,
} from './CanonicalEvent.js';

export const COMPACT_LIVE_RAILS = [
  'item/started:ContextCompaction',
  'item/completed:ContextCompaction',
] as const;

export const COMPACT_DURABLE_RAIL = 'ThreadItem::ContextCompaction' as const;

export const COMPACT_LEGACY_RAILS = [
  'ContextCompacted',
  'thread/compacted',
] as const;

export type CompactRailKind = 'live' | 'durable' | 'legacy' | 'unknown';

export interface CompactRailSignal {
  signal?: string;
  itemType?: string;
}

export interface CompactRailClassification {
  kind: CompactRailKind;
  label: string;
  primary: boolean;
}

export interface BuildCompactContinuationEventInput {
  sessionId: string;
  cwd?: string;
  project?: string;
  compactItemId: string;
  summary: string;
  sourceRange?: {
    fromEventId?: string;
    toEventId?: string;
  };
  trigger?: 'manual' | 'auto' | 'unknown';
  observedAt?: string;
}

export interface DurableCompactRailEntry {
  observationId: number;
  memorySessionId: string;
  durableRail: typeof COMPACT_DURABLE_RAIL;
  summary: string;
  createdAt: string;
}

export interface CompactContinuationSpineInput {
  event?: CanonicalEvent<'compact_summary'>;
  durableEntries?: DurableCompactRailEntry[];
}

function normalizeIdentityPart(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'unknown';
}

export function classifyCompactRail(signal: CompactRailSignal): CompactRailClassification {
  if (signal.itemType === 'ContextCompaction' && signal.signal) {
    return {
      kind: 'live',
      label: `${signal.signal}:ContextCompaction`,
      primary: signal.signal === 'item/started' || signal.signal === 'item/completed',
    };
  }

  if (signal.itemType === COMPACT_DURABLE_RAIL) {
    return {
      kind: 'durable',
      label: COMPACT_DURABLE_RAIL,
      primary: true,
    };
  }

  if (signal.signal && (COMPACT_LEGACY_RAILS as readonly string[]).includes(signal.signal)) {
    return {
      kind: 'legacy',
      label: signal.signal,
      primary: false,
    };
  }

  return {
    kind: 'unknown',
    label: signal.signal ?? signal.itemType ?? 'unknown',
    primary: false,
  };
}

export function buildCompactContinuationEvent(
  input: BuildCompactContinuationEventInput
): CanonicalEvent<'compact_summary'> {
  const sessionId = normalizeIdentityPart(input.sessionId);
  const compactItemId = normalizeIdentityPart(input.compactItemId);

  return defineCanonicalEvent({
    idempotencyKey: `codex:${sessionId}:compact_summary:${compactItemId}`,
    type: 'compact_summary',
    source: {
      rail: 'compact',
      role: 'compact_receipt',
      priority: 'sidecar',
      primaryRail: 'hooks',
      adapter: 'ContextCompaction',
    },
    session: {
      id: input.sessionId,
      platformSource: 'codex',
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(input.project ? { project: input.project } : {}),
    },
    materialization: 'deferred',
    payload: {
      trigger: input.trigger ?? 'unknown',
      summary: input.summary,
      ...(input.sourceRange ? { sourceRange: input.sourceRange } : {}),
    },
    observedAt: input.observedAt,
    metadata: {
      liveRail: [...COMPACT_LIVE_RAILS],
      durableRail: COMPACT_DURABLE_RAIL,
      legacyRails: [...COMPACT_LEGACY_RAILS],
      continuationClaim: 'compact-aware continuation',
      forbiddenClaim: 'PreCompact parity',
    },
  });
}

export function isCompactContinuationEvent(
  event: CanonicalEvent | undefined
): event is CanonicalEvent<'compact_summary'> {
  return event?.type === 'compact_summary' && event.source.rail === 'compact';
}

export function shouldRenderCompactContinuationSpine(input: {
  source?: string;
  canonicalEvent?: CanonicalEvent;
}): boolean {
  return input.source === 'compact' || isCompactContinuationEvent(input.canonicalEvent);
}

export function buildCompactAfterContinuationSpine(input: CompactContinuationSpineInput): string {
  const durableEntries = input.durableEntries ?? [];
  const lines = [
    '## Compact continuation spine',
    '',
    `- live rail: ${COMPACT_LIVE_RAILS.join(', ')}`,
    `- durable rail: ${COMPACT_DURABLE_RAIL}`,
    `- legacy rails: ${COMPACT_LEGACY_RAILS.join(', ')}`,
    '- claim: compact-aware continuation',
    '- forbidden: PreCompact parity',
  ];

  if (input.event?.payload.summary) {
    lines.push(`- compact summary: ${input.event.payload.summary}`);
  }

  const range = input.event?.payload.sourceRange;
  if (range?.fromEventId || range?.toEventId) {
    lines.push(`- source range: ${range.fromEventId ?? 'unknown'} -> ${range.toEventId ?? 'unknown'}`);
  }

  if (durableEntries.length === 0) {
    lines.push('- durable receipt: not found in current durable replay window');
  } else {
    for (const entry of durableEntries) {
      lines.push(`- durable receipt: #${entry.observationId} ${entry.memorySessionId} ${entry.createdAt}`);
      lines.push(`  - summary: ${entry.summary}`);
    }
  }

  return lines.join('\n');
}
