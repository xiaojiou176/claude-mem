import { buildEventIdentity, type StitchableEvent } from './EventIdentity.js';
import { compareEventPriority, shouldReplaceEventTruth } from './EventPriority.js';

export type DuplicateReason =
  | 'higher_priority_replaced_existing'
  | 'lower_priority_filled_gaps_only'
  | 'same_priority_existing_truth_preserved';

export interface EventDuplicateReceipt {
  identity: string;
  keptRail: string;
  droppedRail: string;
  reason: DuplicateReason;
}

export interface EventStitchResult {
  events: StitchableEvent[];
  duplicates: EventDuplicateReceipt[];
}

function railLabel(event: StitchableEvent): string {
  return event.source.rail === 'hooks' ? 'hook' : event.source.rail;
}

function hasOwnKey(input: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(input, key);
}

function fillPayloadGaps(
  primaryPayload: Record<string, unknown>,
  gapSourcePayload: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...primaryPayload };
  for (const [key, value] of Object.entries(gapSourcePayload)) {
    if (!hasOwnKey(merged, key) || merged[key] === undefined) {
      merged[key] = value;
    }
  }
  return merged;
}

function withIdentity(event: StitchableEvent, identity: string): StitchableEvent {
  return {
    ...event,
    idempotencyKey: identity,
  };
}

function mergeGapPayload(target: StitchableEvent, gapSource: StitchableEvent): StitchableEvent {
  return {
    ...target,
    payload: fillPayloadGaps(target.payload, gapSource.payload),
  };
}

export class EventStitcher {
  private readonly events: StitchableEvent[] = [];
  private readonly eventIndexByIdentity = new Map<string, number>();
  private readonly duplicates: EventDuplicateReceipt[] = [];

  add(event: StitchableEvent): StitchableEvent {
    const identity = buildEventIdentity(event);
    const candidate = withIdentity(event, identity);
    const existingIndex = this.eventIndexByIdentity.get(identity);

    if (existingIndex === undefined) {
      this.eventIndexByIdentity.set(identity, this.events.length);
      this.events.push(candidate);
      return candidate;
    }

    const existing = this.events[existingIndex];
    if (shouldReplaceEventTruth(candidate, existing)) {
      const replacement = mergeGapPayload(candidate, existing);
      this.events[existingIndex] = replacement;
      this.duplicates.push({
        identity,
        keptRail: railLabel(replacement),
        droppedRail: railLabel(existing),
        reason: 'higher_priority_replaced_existing',
      });
      return replacement;
    }

    const kept = mergeGapPayload(existing, candidate);
    this.events[existingIndex] = kept;
    const priorityComparison = compareEventPriority(candidate, existing);
    this.duplicates.push({
      identity,
      keptRail: railLabel(kept),
      droppedRail: railLabel(candidate),
      reason: priorityComparison < 0
        ? 'lower_priority_filled_gaps_only'
        : 'same_priority_existing_truth_preserved',
    });
    return kept;
  }

  addMany(events: StitchableEvent[]): void {
    for (const event of events) {
      this.add(event);
    }
  }

  getEvents(): StitchableEvent[] {
    return [...this.events];
  }

  getDuplicates(): EventDuplicateReceipt[] {
    return [...this.duplicates];
  }

  getResult(): EventStitchResult {
    return {
      events: this.getEvents(),
      duplicates: this.getDuplicates(),
    };
  }
}

export function stitchCanonicalEvents(events: StitchableEvent[]): EventStitchResult {
  const stitcher = new EventStitcher();
  stitcher.addMany(events);
  return stitcher.getResult();
}
