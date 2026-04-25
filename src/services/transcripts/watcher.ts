import { existsSync, statSync, watch as fsWatch, createReadStream } from 'fs';
import { basename, join } from 'path';
import { globSync } from 'glob';
import { logger } from '../../utils/logger.js';
import { sessionInitHandler } from '../../cli/handlers/session-init.js';
import { observationHandler } from '../../cli/handlers/observation.js';
import { fileEditHandler } from '../../cli/handlers/file-edit.js';
import { summarizeHandler } from '../../cli/handlers/summarize.js';
import { sessionCompleteHandler } from '../../cli/handlers/session-complete.js';
import { workerHttpRequest as defaultWorkerHttpRequest } from '../../shared/worker-utils.js';
import { writeAgentsMd as defaultWriteAgentsMd } from '../../utils/agents-md-utils.js';
import { expandHomePath } from './config.js';
import { loadWatchState, saveWatchState, type TranscriptWatchState } from './state.js';
import type { TranscriptWatchConfig, TranscriptSchema, WatchTarget } from './types.js';
import { TranscriptEventProcessor } from './processor.js';
import { SessionStore } from '../sqlite/SessionStore.js';
import type { CanonicalEvent } from '../codex-events/CanonicalEvent.js';
import { compileChildReceiptObservations } from '../context/ObservationCompiler.js';
import { COMPACT_DURABLE_RAIL } from '../codex-events/CompactContinuationBuilder.js';

interface TailState {
  offset: number;
  partial: string;
}

type TranscriptSessionStore = Pick<
  SessionStore,
  | 'createSDKSession'
  | 'getSessionById'
  | 'ensureMemorySessionIdRegistered'
  | 'storeObservation'
>;

interface TranscriptWatcherDeps {
  sessionInitExecute?: typeof sessionInitHandler.execute;
  observationExecute?: typeof observationHandler.execute;
  fileEditExecute?: typeof fileEditHandler.execute;
  summarizeExecute?: typeof summarizeHandler.execute;
  sessionCompleteExecute?: typeof sessionCompleteHandler.execute;
  workerHttpRequest?: typeof defaultWorkerHttpRequest;
  writeAgentsMd?: typeof defaultWriteAgentsMd;
  createSessionStore?: () => TranscriptSessionStore;
}

class FileTailer {
  private watcher: ReturnType<typeof fsWatch> | null = null;
  private tailState: TailState;

  constructor(
    private filePath: string,
    initialOffset: number,
    private onLine: (line: string) => Promise<void>,
    private onOffset: (offset: number) => void
  ) {
    this.tailState = { offset: initialOffset, partial: '' };
  }

  start(): void {
    this.readNewData().catch(() => undefined);
    this.watcher = fsWatch(this.filePath, { persistent: true }, () => {
      this.readNewData().catch(() => undefined);
    });
  }

  close(): void {
    this.watcher?.close();
    this.watcher = null;
  }

  private async readNewData(): Promise<void> {
    if (!existsSync(this.filePath)) return;

    let size = 0;
    try {
      size = statSync(this.filePath).size;
    } catch (error: unknown) {
      logger.debug('WORKER', 'Failed to stat transcript file', { file: this.filePath }, error instanceof Error ? error : undefined);
      return;
    }

    if (size < this.tailState.offset) {
      this.tailState.offset = 0;
    }

    if (size === this.tailState.offset) return;

    const stream = createReadStream(this.filePath, {
      start: this.tailState.offset,
      end: size - 1,
      encoding: 'utf8'
    });

    let data = '';
    for await (const chunk of stream) {
      data += chunk as string;
    }

    this.tailState.offset = size;
    this.onOffset(this.tailState.offset);

    const combined = this.tailState.partial + data;
    const lines = combined.split('\n');
    this.tailState.partial = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      await this.onLine(trimmed);
    }
  }
}

export class TranscriptWatcher {
  private processor = new TranscriptEventProcessor();
  private tailers = new Map<string, FileTailer>();
  private state: TranscriptWatchState;
  private rescanTimers: Array<NodeJS.Timeout> = [];
  private readonly deps: Required<TranscriptWatcherDeps>;

  constructor(
    private config: TranscriptWatchConfig,
    private statePath: string,
    deps: TranscriptWatcherDeps = {}
  ) {
    this.state = loadWatchState(statePath);
    this.deps = {
      sessionInitExecute: deps.sessionInitExecute ?? sessionInitHandler.execute,
      observationExecute: deps.observationExecute ?? observationHandler.execute,
      fileEditExecute: deps.fileEditExecute ?? fileEditHandler.execute,
      summarizeExecute: deps.summarizeExecute ?? summarizeHandler.execute,
      sessionCompleteExecute: deps.sessionCompleteExecute ?? sessionCompleteHandler.execute,
      workerHttpRequest: deps.workerHttpRequest ?? defaultWorkerHttpRequest,
      writeAgentsMd: deps.writeAgentsMd ?? defaultWriteAgentsMd,
      createSessionStore: deps.createSessionStore ?? (() => new SessionStore())
    };
  }

  async start(): Promise<void> {
    for (const watch of this.config.watches) {
      await this.setupWatch(watch);
    }
  }

  stop(): void {
    for (const tailer of this.tailers.values()) {
      tailer.close();
    }
    this.tailers.clear();
    for (const timer of this.rescanTimers) {
      clearInterval(timer);
    }
    this.rescanTimers = [];
  }

  private async setupWatch(watch: WatchTarget): Promise<void> {
    const schema = this.resolveSchema(watch);
    if (!schema) {
      logger.warn('TRANSCRIPT', 'Missing schema for watch', { watch: watch.name });
      return;
    }

    const resolvedPath = expandHomePath(watch.path);
    const files = this.resolveWatchFiles(resolvedPath);

    for (const filePath of files) {
      await this.addTailer(filePath, watch, schema, true);
    }

    const rescanIntervalMs = watch.rescanIntervalMs ?? 5000;
      const timer = setInterval(async () => {
      const newFiles = this.resolveWatchFiles(resolvedPath);
      for (const filePath of newFiles) {
        if (!this.tailers.has(filePath)) {
          await this.addTailer(filePath, watch, schema, false);
        }
      }
    }, rescanIntervalMs);
    this.rescanTimers.push(timer);
  }

  private resolveSchema(watch: WatchTarget): TranscriptSchema | null {
    if (typeof watch.schema === 'string') {
      return this.config.schemas?.[watch.schema] ?? null;
    }
    return watch.schema;
  }

  private resolveWatchFiles(inputPath: string): string[] {
    if (this.hasGlob(inputPath)) {
      return globSync(inputPath, { nodir: true, absolute: true });
    }

    if (existsSync(inputPath)) {
      try {
        const stat = statSync(inputPath);
        if (stat.isDirectory()) {
          const pattern = join(inputPath, '**', '*.jsonl');
          return globSync(pattern, { nodir: true, absolute: true });
        }
        return [inputPath];
      } catch (error: unknown) {
        logger.debug('WORKER', 'Failed to stat watch path', { path: inputPath }, error instanceof Error ? error : undefined);
        return [];
      }
    }

    return [];
  }

  private hasGlob(inputPath: string): boolean {
    return /[*?[\]{}()]/.test(inputPath);
  }

  private async addTailer(
    filePath: string,
    watch: WatchTarget,
    schema: TranscriptSchema,
    initialDiscovery: boolean
  ): Promise<void> {
    if (this.tailers.has(filePath)) return;

    const sessionIdOverride = this.extractSessionIdFromPath(filePath);

    let offset = this.state.offsets[filePath] ?? 0;
    // `startAtEnd` is useful on worker startup to avoid replaying the full backlog,
    // but new transcript files must be read from byte 0 or we lose session_meta/user_message.
    if (offset === 0 && watch.startAtEnd && initialDiscovery) {
      try {
        offset = statSync(filePath).size;
      } catch (error: unknown) {
        logger.debug('WORKER', 'Failed to stat file for startAtEnd offset', { file: filePath }, error instanceof Error ? error : undefined);
        offset = 0;
      }
    }

    const tailer = new FileTailer(
      filePath,
      offset,
      async (line: string) => {
        await this.handleLine(line, watch, schema, filePath, sessionIdOverride);
      },
      (newOffset: number) => {
        this.state.offsets[filePath] = newOffset;
        saveWatchState(this.statePath, this.state);
      }
    );

    tailer.start();
    this.tailers.set(filePath, tailer);
    logger.info('TRANSCRIPT', 'Watching transcript file', {
      file: filePath,
      watch: watch.name,
      schema: schema.name
    });
  }

  private async handleLine(
    line: string,
    watch: WatchTarget,
    schema: TranscriptSchema,
    filePath: string,
    sessionIdOverride?: string | null
  ): Promise<void> {
    try {
      const entry = JSON.parse(line);
      const canonicalEvents = await this.processor.processEntry(entry, watch, schema, sessionIdOverride ?? undefined);
      await this.materializeCanonicalEvents(canonicalEvents, filePath);
    } catch (error: unknown) {
      if (error instanceof Error) {
        logger.debug('TRANSCRIPT', 'Failed to parse transcript line', {
          watch: watch.name,
          file: basename(filePath)
        }, error);
      } else {
        logger.warn('TRANSCRIPT', 'Failed to parse transcript line (non-Error thrown)', {
          watch: watch.name,
          file: basename(filePath),
          error: String(error)
        });
      }
    }
  }

  private async materializeCanonicalEvents(
    events: Array<CanonicalEvent | Record<string, any>>,
    transcriptPath: string,
  ): Promise<void> {
    for (const event of events) {
      switch (event.type) {
        case 'session_init':
          await this.deps.sessionInitExecute({
            sessionId: event.session?.id,
            cwd: event.session?.cwd,
            prompt: typeof event.payload?.prompt === 'string' ? event.payload.prompt : '',
            platform: 'codex-cli',
          });
          await this.materializeProjection(event);
          break;
        case 'observation':
          await this.deps.observationExecute({
            sessionId: event.session?.id,
            cwd: event.session?.cwd,
            toolName: event.payload?.toolName,
            toolInput: event.payload?.toolInput,
            toolResponse: event.payload?.toolResponse,
            platform: 'codex-cli',
          });
          break;
        case 'file_edit':
          await this.deps.fileEditExecute({
            sessionId: event.session?.id,
            cwd: event.session?.cwd,
            filePath: event.payload?.filePath,
            edits: event.payload?.edits,
            platform: 'codex-cli',
          });
          break;
        case 'session_end':
          await this.deps.summarizeExecute({
            sessionId: event.session?.id,
            cwd: event.session?.cwd,
            transcriptPath,
            platform: 'codex-cli',
          });
          await this.deps.sessionCompleteExecute({
            sessionId: event.session?.id,
            cwd: event.session?.cwd,
            platform: 'codex-cli',
          });
          await this.materializeProjection(event);
          break;
        case 'child_session':
          this.storeChildReceiptObservation(event as CanonicalEvent<'child_session'>);
          break;
        case 'compact_summary':
          this.storeCompactReceiptObservation(event as CanonicalEvent<'compact_summary'>);
          break;
        default:
          break;
      }
    }
  }

  private async materializeProjection(event: CanonicalEvent | Record<string, any>): Promise<void> {
    const projection = event.payload?.contextProjection;
    const targetPath = typeof projection?.targetPath === 'string' ? projection.targetPath : undefined;
    const project = typeof event.session?.project === 'string' ? event.session.project : undefined;
    if (!projection || !targetPath || !project) return;

    const response = await this.deps.workerHttpRequest(`/api/context/inject?projects=${encodeURIComponent(project)}`, {
      method: 'GET',
    });
    if (!response.ok) return;

    const context = await response.text();
    if (!context || !context.trim()) return;
    this.deps.writeAgentsMd(targetPath, context);
  }

  private getOrCreateSyntheticMemorySessionId(
    store: TranscriptSessionStore,
    contentSessionId: string,
    project: string,
    platformSource: string,
  ): string {
    const sessionDbId = store.createSDKSession(contentSessionId, project, '', undefined, platformSource);
    const dbSession = store.getSessionById(sessionDbId);
    if (dbSession?.memory_session_id) return dbSession.memory_session_id;

    const syntheticId = `codex-transcript-${contentSessionId}`;
    store.ensureMemorySessionIdRegistered(sessionDbId, syntheticId);
    return syntheticId;
  }

  private storeChildReceiptObservation(event: CanonicalEvent<'child_session'>): void {
    const store = this.deps.createSessionStore();
    const project = event.session.project ?? '';
    const memorySessionId = this.getOrCreateSyntheticMemorySessionId(
      store,
      event.session.id,
      project,
      event.session.platformSource,
    );

    const [observation] = compileChildReceiptObservations([event], {
      observedAtEpoch: Date.parse(event.observedAt ?? '') || Date.now(),
    });
    if (!observation) return;

    store.storeObservation(memorySessionId, project, {
      type: observation.type,
      title: observation.title,
      subtitle: observation.subtitle,
      facts: JSON.parse(observation.facts ?? '[]'),
      narrative: observation.narrative,
      concepts: JSON.parse(observation.concepts ?? '[]'),
      files_read: [],
      files_modified: [],
      agent_type: event.payload.agentType ?? null,
      agent_id: event.payload.agentId ?? null,
    }, undefined, 0, Date.parse(observation.created_at) || Date.now());
  }

  private storeCompactReceiptObservation(event: CanonicalEvent<'compact_summary'>): void {
    const store = this.deps.createSessionStore();
    const project = event.session.project ?? '';
    const memorySessionId = this.getOrCreateSyntheticMemorySessionId(
      store,
      event.session.id,
      project,
      event.session.platformSource,
    );

    const summary = typeof event.payload.summary === 'string' && event.payload.summary.trim()
      ? event.payload.summary
      : 'compact durable receipt';

    store.storeObservation(memorySessionId, project, {
      type: 'compact_terminal',
      title: 'Codex compact durable receipt',
      subtitle: 'Codex host-max degraded receipt; not PreCompact parity',
      facts: [
        `durableRail=${COMPACT_DURABLE_RAIL}`,
        `summary=${summary}`,
      ],
      narrative: summary,
      concepts: ['codex', 'ContextCompaction', 'compact-continuation', 'host-max-degraded'],
      files_read: [],
      files_modified: [],
    }, undefined, 0, Date.parse(event.observedAt ?? '') || Date.now());
  }

  private extractSessionIdFromPath(filePath: string): string | null {
    const match = filePath.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    return match ? match[0] : null;
  }
}
