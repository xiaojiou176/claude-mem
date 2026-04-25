/**
 * ObservationCompiler - Query building and data retrieval for context
 *
 * Handles database queries for observations and summaries, plus transcript extraction.
 */

import path from 'path';
import { existsSync, readFileSync } from 'fs';
import { SessionStore } from '../sqlite/SessionStore.js';
import { logger } from '../../utils/logger.js';
import { SYSTEM_REMINDER_REGEX } from '../../utils/tag-stripping.js';
import { CLAUDE_CONFIG_DIR } from '../../shared/paths.js';
import {
  COMPACT_DURABLE_RAIL,
  COMPACT_LEGACY_RAILS,
  type DurableCompactRailEntry,
} from '../codex-events/CompactContinuationBuilder.js';
import type { CanonicalEvent } from '../codex-events/CanonicalEvent.js';
import type {
  ContextConfig,
  Observation,
  SessionSummary,
  SummaryTimelineItem,
  TimelineItem,
  PriorMessages,
} from './types.js';
import { SUMMARY_LOOKAHEAD } from './types.js';

export interface ChildReceiptObservationOptions {
  startId?: number;
  observedAtEpoch?: number;
}

function childReceiptTitle(event: CanonicalEvent<'child_session'>): string {
  const status = event.payload.status ?? 'reported';
  const childSessionId = event.payload.childSessionId ?? event.payload.agentId ?? 'unknown-child';
  return `Codex child ${status}: ${childSessionId}`;
}

export function compileChildReceiptObservations(
  events: Array<CanonicalEvent | Record<string, any>>,
  options: ChildReceiptObservationOptions = {}
): Observation[] {
  const startId = options.startId ?? -1;
  const baseEpoch = options.observedAtEpoch ?? Date.now();
  return events
    .filter((event): event is CanonicalEvent<'child_session'> => event.type === 'child_session')
    .map((event, index) => {
      const childSessionId = event.payload.childSessionId ?? event.payload.agentId ?? 'unknown-child';
      const terminalMessage = typeof event.metadata?.terminalMessage === 'string'
        ? event.metadata.terminalMessage
        : '';
      const observedAt = event.observedAt ?? new Date(baseEpoch + index).toISOString();
      return {
        id: startId + index,
        memory_session_id: event.session.id,
        platform_source: event.session.platformSource,
        type: 'child_terminal',
        title: childReceiptTitle(event),
        subtitle: 'Codex host-max degraded receipt; not SubagentStop parity',
        narrative: terminalMessage,
        facts: JSON.stringify([
          `parent_thread_id=${event.session.id}`,
          `child_agent_path=${childSessionId}`,
          `terminal_status=${event.payload.status ?? 'reported'}`
        ]),
        concepts: JSON.stringify([
          'codex',
          'child-receipt',
          'subagent-notification',
          'host-max-degraded'
        ]),
        files_read: null,
        files_modified: null,
        discovery_tokens: null,
        created_at: observedAt,
        created_at_epoch: baseEpoch + index,
        project: event.session.project
      };
    });
}

/**
 * Query observations from database with type and concept filtering
 */
export function queryObservations(
  db: SessionStore,
  project: string,
  config: ContextConfig
): Observation[] {
  const typeArray = Array.from(config.observationTypes);
  const typePlaceholders = typeArray.map(() => '?').join(',');
  const conceptArray = Array.from(config.observationConcepts);
  const conceptPlaceholders = conceptArray.map(() => '?').join(',');

  return db.db.prepare(`
    SELECT
      o.id,
      o.memory_session_id,
      COALESCE(s.platform_source, 'claude') as platform_source,
      o.type,
      o.title,
      o.subtitle,
      o.narrative,
      o.facts,
      o.concepts,
      o.files_read,
      o.files_modified,
      o.discovery_tokens,
      o.created_at,
      o.created_at_epoch
    FROM observations o
    LEFT JOIN sdk_sessions s ON o.memory_session_id = s.memory_session_id
    WHERE (o.project = ? OR o.merged_into_project = ?)
      AND type IN (${typePlaceholders})
      AND EXISTS (
        SELECT 1 FROM json_each(o.concepts)
        WHERE value IN (${conceptPlaceholders})
      )
    ORDER BY o.created_at_epoch DESC
    LIMIT ?
  `).all(
    project,
    project,
    ...typeArray,
    ...conceptArray,
    config.totalObservationCount
  ) as Observation[];
}

/**
 * Query recent session summaries from database
 */
export function querySummaries(
  db: SessionStore,
  project: string,
  config: ContextConfig
): SessionSummary[] {
  return db.db.prepare(`
    SELECT
      ss.id,
      ss.memory_session_id,
      COALESCE(s.platform_source, 'claude') as platform_source,
      ss.request,
      ss.investigated,
      ss.learned,
      ss.completed,
      ss.next_steps,
      ss.created_at,
      ss.created_at_epoch
    FROM session_summaries ss
    LEFT JOIN sdk_sessions s ON ss.memory_session_id = s.memory_session_id
    WHERE (ss.project = ? OR ss.merged_into_project = ?)
    ORDER BY ss.created_at_epoch DESC
    LIMIT ?
  `).all(project, project, config.sessionCount + SUMMARY_LOOKAHEAD) as SessionSummary[];
}

/**
 * Query observations from multiple projects (for worktree support)
 *
 * Returns observations from all specified projects, interleaved chronologically.
 * Used when running in a worktree to show both parent repo and worktree observations.
 */
export function queryObservationsMulti(
  db: SessionStore,
  projects: string[],
  config: ContextConfig
): Observation[] {
  const typeArray = Array.from(config.observationTypes);
  const typePlaceholders = typeArray.map(() => '?').join(',');
  const conceptArray = Array.from(config.observationConcepts);
  const conceptPlaceholders = conceptArray.map(() => '?').join(',');

  // Build IN clause for projects
  const projectPlaceholders = projects.map(() => '?').join(',');

  return db.db.prepare(`
    SELECT
      o.id,
      o.memory_session_id,
      COALESCE(s.platform_source, 'claude') as platform_source,
      o.type,
      o.title,
      o.subtitle,
      o.narrative,
      o.facts,
      o.concepts,
      o.files_read,
      o.files_modified,
      o.discovery_tokens,
      o.created_at,
      o.created_at_epoch,
      o.project
    FROM observations o
    LEFT JOIN sdk_sessions s ON o.memory_session_id = s.memory_session_id
    WHERE (o.project IN (${projectPlaceholders})
           OR o.merged_into_project IN (${projectPlaceholders}))
      AND type IN (${typePlaceholders})
      AND EXISTS (
        SELECT 1 FROM json_each(o.concepts)
        WHERE value IN (${conceptPlaceholders})
      )
    ORDER BY o.created_at_epoch DESC
    LIMIT ?
  `).all(
    ...projects,
    ...projects,
    ...typeArray,
    ...conceptArray,
    config.totalObservationCount
  ) as Observation[];
}

/**
 * Query session summaries from multiple projects (for worktree support)
 *
 * Returns summaries from all specified projects, interleaved chronologically.
 * Used when running in a worktree to show both parent repo and worktree summaries.
 */
export function querySummariesMulti(
  db: SessionStore,
  projects: string[],
  config: ContextConfig
): SessionSummary[] {
  // Build IN clause for projects
  const projectPlaceholders = projects.map(() => '?').join(',');

  return db.db.prepare(`
    SELECT
      ss.id,
      ss.memory_session_id,
      COALESCE(s.platform_source, 'claude') as platform_source,
      ss.request,
      ss.investigated,
      ss.learned,
      ss.completed,
      ss.next_steps,
      ss.created_at,
      ss.created_at_epoch,
      ss.project
    FROM session_summaries ss
    LEFT JOIN sdk_sessions s ON ss.memory_session_id = s.memory_session_id
    WHERE (ss.project IN (${projectPlaceholders})
           OR ss.merged_into_project IN (${projectPlaceholders}))
    ORDER BY ss.created_at_epoch DESC
    LIMIT ?
  `).all(...projects, ...projects, config.sessionCount + SUMMARY_LOOKAHEAD) as SessionSummary[];
}

/**
 * Convert cwd path to dashed format for transcript lookup
 */
function cwdToDashed(cwd: string): string {
  return cwd.replace(/\//g, '-');
}

/**
 * Find the last assistant message text from parsed transcript lines.
 */
function parseAssistantTextFromLine(line: string): string | null {
  if (!line.includes('"type":"assistant"')) return null;

  const entry = JSON.parse(line);
  if (entry.type === 'assistant' && entry.message?.content && Array.isArray(entry.message.content)) {
    let text = '';
    for (const block of entry.message.content) {
      if (block.type === 'text') text += block.text;
    }
    text = text.replace(SYSTEM_REMINDER_REGEX, '').trim();
    if (text) return text;
  }
  return null;
}

function findLastAssistantMessage(lines: string[]): string {
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const result = parseAssistantTextFromLine(lines[i]);
      if (result) return result;
    } catch (parseError) {
      if (parseError instanceof Error) {
        logger.debug('WORKER', 'Skipping malformed transcript line', { lineIndex: i }, parseError);
      } else {
        logger.debug('WORKER', 'Skipping malformed transcript line', { lineIndex: i, error: String(parseError) });
      }
      continue;
    }
  }
  return '';
}

/**
 * Extract prior messages from transcript file
 */
export function extractPriorMessages(transcriptPath: string): PriorMessages {
  try {
    if (!existsSync(transcriptPath)) return { userMessage: '', assistantMessage: '' };
    const content = readFileSync(transcriptPath, 'utf-8').trim();
    if (!content) return { userMessage: '', assistantMessage: '' };

    const lines = content.split('\n').filter(line => line.trim());
    const lastAssistantMessage = findLastAssistantMessage(lines);
    return { userMessage: '', assistantMessage: lastAssistantMessage };
  } catch (error) {
    if (error instanceof Error) {
      logger.failure('WORKER', 'Failed to extract prior messages from transcript', { transcriptPath }, error);
    } else {
      logger.warn('WORKER', 'Failed to extract prior messages from transcript', { transcriptPath, error: String(error) });
    }
    return { userMessage: '', assistantMessage: '' };
  }
}

/**
 * Get prior session messages if enabled
 */
export function getPriorSessionMessages(
  observations: Observation[],
  config: ContextConfig,
  currentSessionId: string | undefined,
  cwd: string
): PriorMessages {
  if (!config.showLastMessage || observations.length === 0) {
    return { userMessage: '', assistantMessage: '' };
  }

  const priorSessionObs = observations.find(obs => obs.memory_session_id !== currentSessionId);
  if (!priorSessionObs) {
    return { userMessage: '', assistantMessage: '' };
  }

  const priorSessionId = priorSessionObs.memory_session_id;
  const dashedCwd = cwdToDashed(cwd);
  // Use CLAUDE_CONFIG_DIR to support custom Claude config directories
  const transcriptPath = path.join(CLAUDE_CONFIG_DIR, 'projects', dashedCwd, `${priorSessionId}.jsonl`);
  return extractPriorMessages(transcriptPath);
}

/**
 * Prepare summaries for timeline display
 */
export function prepareSummariesForTimeline(
  displaySummaries: SessionSummary[],
  allSummaries: SessionSummary[]
): SummaryTimelineItem[] {
  const mostRecentSummaryId = allSummaries[0]?.id;

  return displaySummaries.map((summary, i) => {
    const olderSummary = i === 0 ? null : allSummaries[i + 1];
    return {
      ...summary,
      displayEpoch: olderSummary ? olderSummary.created_at_epoch : summary.created_at_epoch,
      displayTime: olderSummary ? olderSummary.created_at : summary.created_at,
      shouldShowLink: summary.id !== mostRecentSummaryId
    };
  });
}

/**
 * Build unified timeline from observations and summaries
 */
export function buildTimeline(
  observations: Observation[],
  summaries: SummaryTimelineItem[]
): TimelineItem[] {
  const timeline: TimelineItem[] = [
    ...observations.map(obs => ({ type: 'observation' as const, data: obs })),
    ...summaries.map(summary => ({ type: 'summary' as const, data: summary }))
  ];

  // Sort chronologically
  timeline.sort((a, b) => {
    const aEpoch = a.type === 'observation' ? a.data.created_at_epoch : a.data.displayEpoch;
    const bEpoch = b.type === 'observation' ? b.data.created_at_epoch : b.data.displayEpoch;
    return aEpoch - bEpoch;
  });

  return timeline;
}

/**
 * Get set of observation IDs that should show full details
 */
export function getFullObservationIds(observations: Observation[], count: number): Set<number> {
  return new Set(
    observations
      .slice(0, count)
      .map(obs => obs.id)
  );
}

function parseJsonRecord(value: string | null): Record<string, unknown> {
  if (!value) return {};

  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function parseJsonStringArray(value: string | null): string[] {
  if (!value) return [];

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function hasLegacyOnlyEvidence(observation: Observation): boolean {
  const haystack = [
    observation.title,
    observation.subtitle,
    observation.narrative,
    observation.facts,
    observation.concepts,
  ].filter(Boolean).join('\n');

  return COMPACT_LEGACY_RAILS.some(rail => haystack.includes(rail));
}

/**
 * Extract durable compact receipts from already-loaded observations.
 *
 * The durable rail is intentionally narrower than "any compact-looking text":
 * legacy `thread/compacted` / `ContextCompacted` observations are ignored unless
 * they also carry `ThreadItem::ContextCompaction` evidence.
 */
export function extractDurableCompactRail(observations: Observation[]): DurableCompactRailEntry[] {
  const entries: DurableCompactRailEntry[] = [];

  for (const observation of observations) {
    const facts = parseJsonRecord(observation.facts);
    const concepts = parseJsonStringArray(observation.concepts);
    const durableRail = stringValue(facts.durableRail);
    const hasDurableRail = durableRail === COMPACT_DURABLE_RAIL ||
      concepts.includes('ContextCompaction') && [
        observation.title,
        observation.subtitle,
        observation.narrative,
        observation.facts,
      ].filter(Boolean).join('\n').includes(COMPACT_DURABLE_RAIL);

    if (!hasDurableRail) {
      if (hasLegacyOnlyEvidence(observation)) {
        continue;
      }
      continue;
    }

    entries.push({
      observationId: observation.id,
      memorySessionId: observation.memory_session_id,
      durableRail: COMPACT_DURABLE_RAIL,
      summary: stringValue(facts.summary) ?? observation.narrative ?? observation.title ?? 'compact durable receipt',
      createdAt: observation.created_at,
    });
  }

  return entries;
}
