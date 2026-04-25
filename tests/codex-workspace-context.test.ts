import { describe, it, expect } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import { resolveAgentsMdProjectionTarget, writeAgentsMd } from '../src/utils/agents-md-utils.js';

const configSource = readFileSync(
  join(__dirname, '..', 'src', 'services', 'transcripts', 'config.ts'),
  'utf-8',
);
const processorSource = readFileSync(
  join(__dirname, '..', 'src', 'services', 'transcripts', 'processor.ts'),
  'utf-8',
);
const watcherSource = readFileSync(
  join(__dirname, '..', 'src', 'services', 'transcripts', 'watcher.ts'),
  'utf-8',
);
const installerSource = readFileSync(
  join(__dirname, '..', 'src', 'services', 'integrations', 'CodexCliInstaller.ts'),
  'utf-8',
);

describe('Codex workspace-local context', () => {
  it('does not hardcode ~/.codex/AGENTS.md in the sample transcript watch config', () => {
    expect(configSource).not.toContain("path: '~/.codex/AGENTS.md'");
  });

  it('documents workspace-local AGENTS.md injection for Codex', () => {
    expect(installerSource).toContain('workspace-local AGENTS.md');
    expect(installerSource).toContain('Context files: <workspace>/AGENTS.md');
  });

  it('cleans legacy global Codex context during install', () => {
    expect(installerSource).toContain('cleanupLegacyCodexAgentsMdContext();');
    expect(installerSource).toContain('Removed legacy global context');
  });

  it('declares Codex transcript watching as fallback/replay/audit rather than primary', () => {
    expect(configSource).toContain('CODEX_TRANSCRIPT_ROLE');
    expect(configSource).toContain("primary: false");
    expect(configSource).toContain("'fallback'");
    expect(configSource).toContain("'replay'");
    expect(configSource).toContain("'audit'");
  });

  it('keeps transcript watcher startup safe for hook-first Codex by tailing existing files from end', () => {
    expect(configSource).toContain("path: '~/.codex/sessions/**/*.jsonl'");
    expect(configSource).toContain('startAtEnd: true');
    expect(watcherSource).toContain('initialDiscovery');
    expect(watcherSource).toContain('new transcript files must be read from byte 0');
  });

  it('marks transcript-derived handler calls with fallback/replay/audit metadata for Phase 2 dedupe', () => {
    expect(processorSource).toContain('TRANSCRIPT_EVENT_METADATA');
    expect(processorSource).toContain("sourceRail: 'transcript'");
    expect(processorSource).toContain("railRole: 'fallback_replay_audit'");
    expect(processorSource).toContain("canonicalPriority: 'secondary'");
  });

  it('records upstream-safe source truth that transcript is secondary fallback/replay/audit after hook-first', () => {
    expect(configSource).toContain("primary: false");
    expect(configSource).toContain("primaryRail: 'hooks'");
    expect(configSource).toContain("roles: ['fallback', 'replay', 'audit']");
    expect(configSource).toContain('Fallback/replay/audit schema for Codex session JSONL files');
  });

  it('writes AGENTS.md as a projection sink and replaces only the tagged block', () => {
    const tempDir = join(tmpdir(), `claude-mem-agents-projection-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
    const agentsPath = join(tempDir, 'AGENTS.md');
    writeFileSync(agentsPath, [
      '# Project Rules',
      '',
      'Keep this human-authored instruction.',
      '',
      '<claude-mem-context>',
      'old projected context',
      '</claude-mem-context>',
      '',
      '## Footer',
      'Keep this footer.',
      ''
    ].join('\n'));

    try {
      writeAgentsMd(agentsPath, 'fresh projected context');
      const content = readFileSync(agentsPath, 'utf-8');

      expect(content).toContain('Keep this human-authored instruction.');
      expect(content).toContain('Keep this footer.');
      expect(content).toContain('workspace-native context projection sink');
      expect(content).toContain('not a transcript cache, observation store, or durable database');
      expect(content).toContain('fresh projected context');
      expect(content).not.toContain('old projected context');
      expect(content.match(/<claude-mem-context>/g)).toHaveLength(1);
      expect(content.match(/<\/claude-mem-context>/g)).toHaveLength(1);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('resolves tilde-based AGENTS projector paths before applying precedence', () => {
    const home = homedir();

    expect(resolveAgentsMdProjectionTarget({
      workspace: '~/repo',
      cwd: '~/repo/packages/nested',
    })).toEqual(expect.objectContaining({
      targetPath: join(home, 'repo', 'AGENTS.md'),
      targetScope: 'workspace',
      cwdDriftStatus: 'observed_cwd_nested_under_workspace_projection_stays_at_workspace_root',
    }));

    expect(resolveAgentsMdProjectionTarget({
      contextPath: '~/repo/.agents/context/AGENTS.md',
      workspace: '/ignored/workspace',
      cwd: '/ignored/cwd',
    })).toEqual(expect.objectContaining({
      targetPath: join(home, 'repo', '.agents', 'context', 'AGENTS.md'),
      targetScope: 'explicit',
      cwdDriftStatus: 'explicit_context_path_controls_projection_target',
    }));
  });
});
