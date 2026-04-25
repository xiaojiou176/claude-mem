import type { StitchableEvent } from './EventIdentity.js';

export type EventRailRole =
  | 'primary'
  | 'fallback_replay_audit'
  | 'child_receipt'
  | 'compact_receipt'
  | 'unknown';

export type EventOverwritePolicy =
  | 'wins_over_lower_priority'
  | 'fill_gaps_only'
  | 'sidecar_only'
  | 'preserve_existing_truth';

export interface EventPriorityPolicy {
  rank: number;
  railRole: EventRailRole;
  overwritePolicy: EventOverwritePolicy;
}

export const SOURCE_PRIORITY_TABLE = {
  hook: {
    rank: 100,
    railRole: 'primary',
    overwritePolicy: 'wins_over_lower_priority',
  },
  hooks: {
    rank: 100,
    railRole: 'primary',
    overwritePolicy: 'wins_over_lower_priority',
  },
  transcript: {
    rank: 10,
    railRole: 'fallback_replay_audit',
    overwritePolicy: 'fill_gaps_only',
  },
  child: {
    rank: 50,
    railRole: 'child_receipt',
    overwritePolicy: 'sidecar_only',
  },
  compact: {
    rank: 50,
    railRole: 'compact_receipt',
    overwritePolicy: 'sidecar_only',
  },
  unknown: {
    rank: 0,
    railRole: 'unknown',
    overwritePolicy: 'preserve_existing_truth',
  },
} as const satisfies Record<string, EventPriorityPolicy>;

export type SourcePriorityRail = keyof typeof SOURCE_PRIORITY_TABLE;

function normalizeRail(rail: string | undefined): SourcePriorityRail {
  if (rail === 'hook' || rail === 'hooks') return rail;
  if (rail === 'transcript') return 'transcript';
  if (rail === 'child') return 'child';
  if (rail === 'compact') return 'compact';
  return 'unknown';
}

export function getEventPriority(event: StitchableEvent): EventPriorityPolicy {
  return SOURCE_PRIORITY_TABLE[normalizeRail(event.source.rail)];
}

export function compareEventPriority(candidate: StitchableEvent, existing: StitchableEvent): number {
  return getEventPriority(candidate).rank - getEventPriority(existing).rank;
}

export function shouldReplaceEventTruth(candidate: StitchableEvent, existing: StitchableEvent): boolean {
  return compareEventPriority(candidate, existing) > 0;
}
