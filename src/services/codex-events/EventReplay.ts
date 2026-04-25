import type { CanonicalEvent, CanonicalReplayMetadata } from './CanonicalEvent.js';

export const CANONICAL_TRANSCRIPT_REPLAY_DEFAULTS = {
  mode: 'source_adapter',
  recovery: 'fill_missing_events_only',
  overwritePolicy: 'never_overwrite_hook_primary',
  lateArrivalPolicy: 'preserve_existing_order',
} as const satisfies CanonicalReplayMetadata;

export function createTranscriptReplayMetadata(
  overrides: Partial<CanonicalReplayMetadata> = {}
): CanonicalReplayMetadata {
  return {
    ...CANONICAL_TRANSCRIPT_REPLAY_DEFAULTS,
    ...overrides,
  };
}

export function withReplayDefaults<TEvent extends CanonicalEvent>(event: TEvent): TEvent {
  return {
    ...event,
    replay: event.replay ?? createTranscriptReplayMetadata(),
  };
}
