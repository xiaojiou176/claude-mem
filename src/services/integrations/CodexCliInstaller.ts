/**
 * CodexCliInstaller - Codex CLI integration for claude-mem
 *
 * Uses hook-first basic ingestion with transcript-backed fallback. The hook
 * path routes Codex lifecycle events through the same handler mainline used by
 * other CLI integrations:
 *
 * 1. SessionStart → context
 * 2. UserPromptSubmit → session-init
 * 3. PostToolUse → observation
 * 4. Stop → summarize
 *
 * Transcript watching remains installed as fallback / replay / audit:
 *
 * 1. Writes/merges transcript-watch config to ~/.claude-mem/transcript-watch.json
 * 2. Sets up watch for ~/.codex/sessions/**\/*.jsonl using existing watcher
 * 3. Injects context via workspace-local AGENTS.md files (Codex reads these natively)
 *
 * Anti-patterns:
 *   - Does NOT describe Codex as transcript-only
 *   - Does NOT modify existing transcript watcher infrastructure
 *   - Does NOT overwrite existing transcript-watch.json -- merges only
 *   - Does NOT overwrite existing Codex hooks -- preserves non-claude-mem hooks
 */

import path from 'path';
import { homedir } from 'os';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { logger } from '../../utils/logger.js';
import { replaceTaggedContent } from '../../utils/claude-md-utils.js';
import { findBunPath, findWorkerServicePath } from './CursorHooksInstaller.js';
import {
  DEFAULT_CONFIG_PATH,
  DEFAULT_STATE_PATH,
  SAMPLE_CONFIG,
} from '../transcripts/config.js';
import type { TranscriptWatchConfig, WatchTarget } from '../transcripts/types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CODEX_DIR = path.join(homedir(), '.codex');
const CODEX_AGENTS_MD_PATH = path.join(CODEX_DIR, 'AGENTS.md');
const CODEX_HOOKS_JSON_PATH = path.join(CODEX_DIR, 'hooks.json');
const CLAUDE_MEM_DIR = path.join(homedir(), '.claude-mem');

/**
 * The watch name used to identify the Codex CLI entry in transcript-watch.json.
 * Must match the name in SAMPLE_CONFIG for merging to work correctly.
 */
const CODEX_WATCH_NAME = 'codex';
const CODEX_HOOK_NAME = 'claude-mem';
const CODEX_HOOK_TIMEOUT_SECONDS = 10;

const CODEX_EVENT_TO_INTERNAL_EVENT: Record<string, string> = {
  SessionStart: 'context',
  UserPromptSubmit: 'session-init',
  PostToolUse: 'observation',
  Stop: 'summarize',
};

export interface CodexHookEntry {
  type: 'command';
  name: string;
  command: string;
  timeout: number;
}

export interface CodexHookGroup {
  matcher?: string;
  hooks: CodexHookEntry[];
}

export interface CodexHooksJson {
  hooks: Record<string, CodexHookGroup[]>;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Codex Hook Config
// ---------------------------------------------------------------------------

function buildCodexHookCommand(
  bunPath: string,
  workerServicePath: string,
  codexEventName: string,
): string {
  const internalEvent = CODEX_EVENT_TO_INTERNAL_EVENT[codexEventName];
  if (!internalEvent) {
    throw new Error(`Unknown Codex hook event: ${codexEventName}`);
  }

  const escapedBunPath = bunPath.replace(/\\/g, '\\\\');
  const escapedWorkerPath = workerServicePath.replace(/\\/g, '\\\\');

  return `"${escapedBunPath}" "${escapedWorkerPath}" hook codex-cli ${internalEvent}`;
}

function createCodexHookGroup(command: string): CodexHookGroup {
  return {
    matcher: '*',
    hooks: [{
      type: 'command',
      name: CODEX_HOOK_NAME,
      command,
      timeout: CODEX_HOOK_TIMEOUT_SECONDS,
    }],
  };
}

export function buildCodexHookConfig(
  bunPath: string,
  workerServicePath: string,
): CodexHooksJson {
  const hooks: Record<string, CodexHookGroup[]> = {};

  for (const codexEvent of Object.keys(CODEX_EVENT_TO_INTERNAL_EVENT)) {
    hooks[codexEvent] = [
      createCodexHookGroup(buildCodexHookCommand(bunPath, workerServicePath, codexEvent)),
    ];
  }

  return { hooks };
}

function readExistingCodexHooksConfig(): CodexHooksJson {
  if (!existsSync(CODEX_HOOKS_JSON_PATH)) {
    return { hooks: {} };
  }

  const raw = readFileSync(CODEX_HOOKS_JSON_PATH, 'utf-8');
  try {
    const parsed = JSON.parse(raw) as Partial<CodexHooksJson>;
    return {
      ...parsed,
      hooks: parsed.hooks ?? {},
    };
  } catch (error) {
    const normalizedError = error instanceof Error ? error : new Error(String(error));
    logger.error('WORKER', 'Corrupt Codex hooks.json, refusing to overwrite', { path: CODEX_HOOKS_JSON_PATH }, normalizedError);
    throw new Error(`Corrupt JSON in ${CODEX_HOOKS_JSON_PATH}, refusing to overwrite existing Codex hooks`);
  }
}

export function mergeCodexHooksIntoConfig(
  existingConfig: Partial<CodexHooksJson>,
  codexHooksConfig: CodexHooksJson,
): CodexHooksJson {
  const merged: CodexHooksJson = {
    ...existingConfig,
    hooks: { ...(existingConfig.hooks ?? {}) },
  };

  for (const [eventName, claudeMemGroups] of Object.entries(codexHooksConfig.hooks)) {
    const existingGroups = merged.hooks[eventName] ?? [];
    const groupsWithoutOldClaudeMem = existingGroups
      .map((group) => ({
        ...group,
        hooks: (group.hooks ?? []).filter((hook) => hook.name !== CODEX_HOOK_NAME),
      }))
      .filter((group) => group.hooks.length > 0);

    merged.hooks[eventName] = [
      ...groupsWithoutOldClaudeMem,
      ...claudeMemGroups,
    ];
  }

  return merged;
}

function writeCodexHooksConfig(config: CodexHooksJson): void {
  mkdirSync(CODEX_DIR, { recursive: true });
  writeFileSync(CODEX_HOOKS_JSON_PATH, JSON.stringify(config, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// Transcript Watch Config Merging
// ---------------------------------------------------------------------------

/**
 * Load existing transcript-watch.json, or return an empty config scaffold.
 * Never throws -- returns a valid empty config on any parse error.
 */
function loadExistingTranscriptWatchConfig(): TranscriptWatchConfig {
  const configPath = DEFAULT_CONFIG_PATH;

  if (!existsSync(configPath)) {
    return { version: 1, schemas: {}, watches: [], stateFile: DEFAULT_STATE_PATH };
  }

  try {
    const raw = readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw) as TranscriptWatchConfig;

    // Ensure required fields exist
    if (!parsed.version) parsed.version = 1;
    if (!parsed.watches) parsed.watches = [];
    if (!parsed.schemas) parsed.schemas = {};
    if (!parsed.stateFile) parsed.stateFile = DEFAULT_STATE_PATH;

    return parsed;
  } catch (parseError) {
    if (parseError instanceof Error) {
      logger.error('WORKER', 'Corrupt transcript-watch.json, creating backup', { path: configPath }, parseError);
    } else {
      logger.error('WORKER', 'Corrupt transcript-watch.json, creating backup', { path: configPath }, new Error(String(parseError)));
    }

    // Back up corrupt file
    const backupPath = `${configPath}.backup.${Date.now()}`;
    writeFileSync(backupPath, readFileSync(configPath));
    console.warn(`  Backed up corrupt transcript-watch.json to ${backupPath}`);

    return { version: 1, schemas: {}, watches: [], stateFile: DEFAULT_STATE_PATH };
  }
}

/**
 * Merge Codex watch configuration into existing transcript-watch.json.
 *
 * - If a watch with name 'codex' already exists, it is replaced in-place.
 * - If the 'codex' schema already exists, it is replaced in-place.
 * - All other watches and schemas are preserved untouched.
 */
function mergeCodexWatchConfig(existingConfig: TranscriptWatchConfig): TranscriptWatchConfig {
  const merged = { ...existingConfig };

  // Merge schemas: add/replace the codex schema
  merged.schemas = { ...merged.schemas };
  const codexSchema = SAMPLE_CONFIG.schemas?.[CODEX_WATCH_NAME];
  if (codexSchema) {
    merged.schemas[CODEX_WATCH_NAME] = codexSchema;
  }

  // Merge watches: add/replace the codex watch entry
  const codexWatchFromSample = SAMPLE_CONFIG.watches.find(
    (w: WatchTarget) => w.name === CODEX_WATCH_NAME,
  );

  if (codexWatchFromSample) {
    const existingWatchIndex = merged.watches.findIndex(
      (w: WatchTarget) => w.name === CODEX_WATCH_NAME,
    );

    if (existingWatchIndex !== -1) {
      // Replace existing codex watch in-place
      merged.watches[existingWatchIndex] = codexWatchFromSample;
    } else {
      // Append new codex watch
      merged.watches.push(codexWatchFromSample);
    }
  }

  return merged;
}

/**
 * Write the merged transcript-watch.json config atomically.
 */
function writeTranscriptWatchConfig(config: TranscriptWatchConfig): void {
  mkdirSync(CLAUDE_MEM_DIR, { recursive: true });
  writeFileSync(DEFAULT_CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// Context Injection (AGENTS.md)
// ---------------------------------------------------------------------------

/**
 * Remove legacy claude-mem context from ~/.codex/AGENTS.md.
 * Codex now uses workspace-local AGENTS.md files to avoid cross-project bleed.
 * Preserves any existing user content outside the tags.
 */
function removeCodexAgentsMdContext(): void {
  if (!existsSync(CODEX_AGENTS_MD_PATH)) return;

  const startTag = '<claude-mem-context>';
  const endTag = '</claude-mem-context>';

  try {
    readAndStripContextTags(startTag, endTag);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn('WORKER', 'Failed to clean AGENTS.md context', { error: message });
  }
}

function readAndStripContextTags(startTag: string, endTag: string): void {
  const content = readFileSync(CODEX_AGENTS_MD_PATH, 'utf-8');

  const startIdx = content.indexOf(startTag);
  const endIdx = content.indexOf(endTag);

  if (startIdx === -1 || endIdx === -1) return;

  const before = content.substring(0, startIdx).replace(/\n+$/, '');
  const after = content.substring(endIdx + endTag.length).replace(/^\n+/, '');
  const finalContent = (before + (after ? '\n\n' + after : '')).trim();

  if (finalContent) {
    writeFileSync(CODEX_AGENTS_MD_PATH, finalContent + '\n');
  } else {
    writeFileSync(CODEX_AGENTS_MD_PATH, '');
  }

  console.log(`  Removed legacy global context from ${CODEX_AGENTS_MD_PATH}`);
}

/**
 * @deprecated Codex now uses workspace-local AGENTS.md via transcript processor fallback.
 * Preserves user content outside the <claude-mem-context> tags.
 */
const cleanupLegacyCodexAgentsMdContext = removeCodexAgentsMdContext;

// ---------------------------------------------------------------------------
// Public API: Install
// ---------------------------------------------------------------------------

/**
 * Install Codex CLI integration for claude-mem.
 *
 * 1. Merges hook-first Codex handlers into ~/.codex/hooks.json
 * 2. Merges Codex transcript-watch fallback into ~/.claude-mem/transcript-watch.json
 * 3. Cleans up any legacy global context block in ~/.codex/AGENTS.md
 *
 * @returns 0 on success, 1 on failure
 */
export async function installCodexCli(): Promise<number> {
  console.log('\nInstalling Claude-Mem for Codex CLI (hook-first basic + transcript fallback)...\n');

  const workerServicePath = findWorkerServicePath();
  if (!workerServicePath) {
    console.error('Could not find worker-service.cjs');
    console.error('   Expected at: ~/.claude/plugins/marketplaces/thedotmack/plugin/scripts/worker-service.cjs');
    return 1;
  }

  const bunPath = findBunPath();
  console.log(`  Using Bun runtime: ${bunPath}`);
  console.log(`  Worker service: ${workerServicePath}`);

  try {
    // Step 1: Merge Codex hook config
    const existingHooksConfig = readExistingCodexHooksConfig();
    const codexHooksConfig = buildCodexHookConfig(bunPath, workerServicePath);
    const mergedHooksConfig = mergeCodexHooksIntoConfig(existingHooksConfig, codexHooksConfig);

    // Step 2: Merge transcript-watch fallback config
    const existingConfig = loadExistingTranscriptWatchConfig();
    const mergedConfig = mergeCodexWatchConfig(existingConfig);

    writeConfigAndShowCodexInstructions(mergedHooksConfig, mergedConfig);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\nInstallation failed: ${message}`);
    return 1;
  }
}

function writeConfigAndShowCodexInstructions(
  mergedHooksConfig: CodexHooksJson,
  mergedConfig: TranscriptWatchConfig,
): void {
  writeCodexHooksConfig(mergedHooksConfig);
  console.log(`  Merged hook-first handlers into ${CODEX_HOOKS_JSON_PATH}`);

  writeTranscriptWatchConfig(mergedConfig);
  console.log(`  Updated transcript fallback config: ${DEFAULT_CONFIG_PATH}`);
  console.log(`  Watch path: ~/.codex/sessions/**/*.jsonl`);
  console.log(`  Schema: codex (v${SAMPLE_CONFIG.schemas?.codex?.version ?? '?'})`);

  cleanupLegacyCodexAgentsMdContext();

  console.log(`
Installation complete!

Hooks installed to: ${CODEX_HOOKS_JSON_PATH}
Hook-first path:
  - SessionStart → context
  - UserPromptSubmit → session-init
  - PostToolUse → observation
  - Stop → summarize

Transcript watch config: ${DEFAULT_CONFIG_PATH}
Context files: <workspace>/AGENTS.md

How it works:
  - claude-mem handles Codex lifecycle events through hook-first basic
  - transcript watching remains available for fallback / replay / audit
  - Context from past sessions is injected via AGENTS.md in the active Codex workspace

Next steps:
  1. Start claude-mem worker: npx claude-mem start
  2. Restart Codex CLI so it loads the updated hooks
  3. Use Codex CLI as usual -- memory capture is automatic!
`);
}

// ---------------------------------------------------------------------------
// Public API: Uninstall
// ---------------------------------------------------------------------------

/**
 * Remove Codex CLI integration from claude-mem.
 *
 * 1. Removes claude-mem Codex hook entries from hooks.json (preserves others)
 * 2. Removes the codex watch and schema from transcript-watch.json (preserves others)
 * 3. Removes context section from AGENTS.md (preserves user content)
 *
 * @returns 0 on success, 1 on failure
 */
export function uninstallCodexCli(): number {
  console.log('\nUninstalling Claude-Mem Codex CLI integration...\n');

  // Step 1: Remove hook-first entries from ~/.codex/hooks.json
  if (existsSync(CODEX_HOOKS_JSON_PATH)) {
    try {
      const config = readExistingCodexHooksConfig();
      for (const eventName of Object.keys(CODEX_EVENT_TO_INTERNAL_EVENT)) {
        const groups = config.hooks[eventName] ?? [];
        const filteredGroups = groups
          .map((group) => ({
            ...group,
            hooks: (group.hooks ?? []).filter((hook) => hook.name !== CODEX_HOOK_NAME),
          }))
          .filter((group) => group.hooks.length > 0);

        if (filteredGroups.length > 0) {
          config.hooks[eventName] = filteredGroups;
        } else {
          delete config.hooks[eventName];
        }
      }
      writeCodexHooksConfig(config);
      console.log(`  Removed claude-mem Codex hooks from ${CODEX_HOOKS_JSON_PATH}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`\nUninstallation failed: ${message}`);
      return 1;
    }
  } else {
    console.log('  No Codex hooks.json found -- no hook entries to remove.');
  }

  // Step 2: Remove codex watch from transcript-watch.json
  if (existsSync(DEFAULT_CONFIG_PATH)) {
    const config = loadExistingTranscriptWatchConfig();

    config.watches = config.watches.filter(
      (w: WatchTarget) => w.name !== CODEX_WATCH_NAME,
    );

    if (config.schemas) {
      delete config.schemas[CODEX_WATCH_NAME];
    }

    try {
      writeTranscriptWatchConfig(config);
      console.log(`  Removed codex watch from ${DEFAULT_CONFIG_PATH}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`\nUninstallation failed: ${message}`);
      return 1;
    }
  } else {
    console.log('  No transcript-watch.json found -- nothing to remove.');
  }

  // Step 3: Remove legacy global context section from AGENTS.md
  cleanupLegacyCodexAgentsMdContext();

  console.log('\nUninstallation complete!');
  console.log('Restart claude-mem worker to apply changes.\n');

  return 0;
}

// ---------------------------------------------------------------------------
// Public API: Status Check
// ---------------------------------------------------------------------------

/**
 * Check Codex CLI integration status.
 *
 * @returns 0 always (informational)
 */
export function checkCodexCliStatus(): number {
  console.log('\nClaude-Mem Codex CLI Integration Status\n');

  // Check hook-first path
  if (existsSync(CODEX_HOOKS_JSON_PATH)) {
    try {
      const hooksConfig = readExistingCodexHooksConfig();
      const installedEvents = Object.keys(CODEX_EVENT_TO_INTERNAL_EVENT).filter((eventName) =>
        (hooksConfig.hooks[eventName] ?? []).some((group) =>
          (group.hooks ?? []).some((hook) => hook.name === CODEX_HOOK_NAME),
        ),
      );

      if (installedEvents.length > 0) {
        console.log('Hook mode: Installed');
        console.log(`  Config: ${CODEX_HOOKS_JSON_PATH}`);
        console.log(`  Events: ${installedEvents.join(', ')}`);
      } else {
        console.log('Hook mode: Not installed');
        console.log(`  No claude-mem hook entries in ${CODEX_HOOKS_JSON_PATH}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log('Hook mode: Unknown');
      console.log(`  Could not parse Codex hooks config: ${message}`);
    }
  } else {
    console.log('Hook mode: Not installed');
    console.log(`  No Codex hooks config at ${CODEX_HOOKS_JSON_PATH}`);
  }

  console.log('');

  // Check transcript-watch.json
  if (!existsSync(DEFAULT_CONFIG_PATH)) {
    console.log('Transcript fallback: Not installed');
    console.log(`  No transcript watch config at ${DEFAULT_CONFIG_PATH}`);
    console.log('\nRun: npx claude-mem install --ide codex-cli\n');
    return 0;
  }

  let config: TranscriptWatchConfig;
  try {
    config = loadExistingTranscriptWatchConfig();
  } catch (error) {
    if (error instanceof Error) {
      logger.error('WORKER', 'Could not parse transcript-watch.json', { path: DEFAULT_CONFIG_PATH }, error);
    } else {
      logger.error('WORKER', 'Could not parse transcript-watch.json', { path: DEFAULT_CONFIG_PATH }, new Error(String(error)));
    }
    console.log('Transcript fallback: Unknown');
    console.log('  Could not parse transcript-watch.json.');
    console.log('');
    return 0;
  }

  const codexWatch = config.watches.find(
    (w: WatchTarget) => w.name === CODEX_WATCH_NAME,
  );
  const codexSchema = config.schemas?.[CODEX_WATCH_NAME];

  if (!codexWatch) {
    console.log('Transcript fallback: Not installed');
    console.log('  transcript-watch.json exists but no codex watch configured.');
    console.log('\nRun: npx claude-mem install --ide codex-cli\n');
    return 0;
  }

  console.log('Transcript fallback: Installed');
  console.log(`  Config: ${DEFAULT_CONFIG_PATH}`);
  console.log(`  Watch path: ${codexWatch.path}`);
  console.log(`  Schema: ${codexSchema ? `codex (v${codexSchema.version ?? '?'})` : 'missing'}`);
  console.log(`  Start at end: ${codexWatch.startAtEnd ?? false}`);

  if (codexWatch.context) {
    console.log(`  Context mode: ${codexWatch.context.mode}`);
    console.log(`  Context path: ${codexWatch.context.path ?? '<workspace>/AGENTS.md (default)'}`);
    console.log(`  Context updates on: ${codexWatch.context.updateOn?.join(', ') ?? 'none'}`);
  }

  if (existsSync(CODEX_AGENTS_MD_PATH)) {
    const mdContent = readFileSync(CODEX_AGENTS_MD_PATH, 'utf-8');
    if (mdContent.includes('<claude-mem-context>')) {
      console.log(`  Legacy global context: Present (${CODEX_AGENTS_MD_PATH})`);
    } else {
      console.log(`  Legacy global context: Not active`);
    }
  } else {
    console.log(`  Legacy global context: None`);
  }

  const sessionsDir = path.join(CODEX_DIR, 'sessions');
  if (existsSync(sessionsDir)) {
    console.log(`  Sessions directory: exists`);
  } else {
    console.log(`  Sessions directory: not yet created (use Codex CLI to generate sessions)`);
  }

  console.log('');
  return 0;
}
