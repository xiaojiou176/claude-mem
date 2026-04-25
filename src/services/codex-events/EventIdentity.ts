import type { CanonicalEventType } from './CanonicalEvent.js';

export type StitchableEventPayload = Record<string, unknown>;

export interface StitchableEventSource {
  rail: string;
  role?: string;
  priority?: string;
  primaryRail?: string;
  adapter?: string;
}

export interface StitchableEventSession {
  id: string;
  platformSource: string;
  cwd?: string;
  project?: string;
  transcriptPath?: string;
  parentSessionId?: string;
  turnId?: string;
}

export interface StitchableEvent {
  idempotencyKey?: string;
  type: CanonicalEventType | string;
  source: StitchableEventSource;
  session: StitchableEventSession;
  payload: StitchableEventPayload;
  observedAt?: string | number;
  replay?: Record<string, unknown>;
  links?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  materialization?: string;
}

export function normalizeEventIdentityPart(value: unknown): string {
  if (value === null || value === undefined) return 'unknown';
  const normalized = String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return normalized.length > 0 ? normalized : 'unknown';
}

function normalizePathIdentityPart(value: unknown): string {
  if (value === null || value === undefined) return 'unknown';
  const normalized = String(value)
    .trim()
    .toLowerCase()
    .replace(/\\/g, '/')
    .replace(/[^a-z0-9._/-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return normalized.length > 0 ? normalized : 'unknown';
}

function payloadStringValue(payload: StitchableEventPayload, key: string): string | undefined {
  const value = payload[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function eventDiscriminator(event: StitchableEvent): string | undefined {
  const toolId = payloadStringValue(event.payload, 'toolId');
  const filePath = payloadStringValue(event.payload, 'filePath');
  const childSessionId = payloadStringValue(event.payload, 'childSessionId');
  const parentEventId = payloadStringValue(event.payload, 'parentEventId');

  if (event.type === 'file_edit' && filePath) {
    return toolId
      ? `${normalizePathIdentityPart(filePath)}:${normalizeEventIdentityPart(toolId)}`
      : normalizePathIdentityPart(filePath);
  }
  if (toolId) return normalizeEventIdentityPart(toolId);
  if (childSessionId) return normalizeEventIdentityPart(childSessionId);
  if (parentEventId) return normalizeEventIdentityPart(parentEventId);
  if (event.session.turnId) return normalizeEventIdentityPart(event.session.turnId);
  return undefined;
}

export function buildEventIdentity(event: StitchableEvent): string {
  if (event.idempotencyKey && event.idempotencyKey.trim().length > 0) {
    return event.idempotencyKey;
  }

  const platformSource = normalizeEventIdentityPart(event.session.platformSource);
  const sessionId = normalizeEventIdentityPart(event.session.id);
  const eventType = normalizeEventIdentityPart(event.type);
  const base = `${platformSource}:${sessionId}:${eventType}`;
  const discriminator = eventDiscriminator(event);
  return discriminator ? `${base}:${discriminator}` : base;
}
