import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'fs';
import { dirname, isAbsolute, resolve } from 'path';
import { homedir } from 'os';
import { replaceTaggedContent } from './claude-md-utils.js';
import { logger } from './logger.js';

export interface AgentsMdProjectionTargetInput {
  contextPath?: string;
  workspace?: string;
  cwd?: string;
}

export interface AgentsMdProjectionTarget {
  targetPath: string;
  targetScope: 'explicit' | 'workspace' | 'cwd';
  precedence: 'explicit_context_path > watch.workspace > observed_cwd';
  cwdDriftStatus:
    | 'explicit_context_path_controls_projection_target'
    | 'observed_cwd_nested_under_workspace_projection_stays_at_workspace_root'
    | 'observed_cwd_outside_workspace_projection_stays_at_workspace_root'
    | 'workspace_projection_target'
    | 'observed_cwd_controls_projection_target';
}

function isNestedUnderWorkspace(workspace: string, cwd: string): boolean {
  const normalizedWorkspace = resolve(workspace);
  const normalizedCwd = resolve(cwd);
  return normalizedCwd !== normalizedWorkspace && normalizedCwd.startsWith(`${normalizedWorkspace}/`);
}

function expandTildePath(value: string): string {
  if (value === '~' || value.startsWith('~/')) {
    return value.replace(/^~/, homedir());
  }
  return value;
}

function normalizePathInput(value?: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return expandTildePath(trimmed);
}

export function resolveAgentsMdProjectionTarget(input: AgentsMdProjectionTargetInput): AgentsMdProjectionTarget | undefined {
  const precedence = 'explicit_context_path > watch.workspace > observed_cwd' as const;
  const workspace = normalizePathInput(input.workspace);
  const cwd = normalizePathInput(input.cwd);
  const contextPath = normalizePathInput(input.contextPath);

  if (contextPath) {
    const base = workspace || cwd;
    return {
      targetPath: isAbsolute(contextPath) ? resolve(contextPath) : resolve(base ?? '', contextPath),
      targetScope: 'explicit',
      precedence,
      cwdDriftStatus: 'explicit_context_path_controls_projection_target'
    };
  }

  if (workspace) {
    let cwdDriftStatus: AgentsMdProjectionTarget['cwdDriftStatus'] = 'workspace_projection_target';
    if (cwd && isNestedUnderWorkspace(workspace, cwd)) {
      cwdDriftStatus = 'observed_cwd_nested_under_workspace_projection_stays_at_workspace_root';
    } else if (cwd && resolve(cwd) !== resolve(workspace)) {
      cwdDriftStatus = 'observed_cwd_outside_workspace_projection_stays_at_workspace_root';
    }

    return {
      targetPath: resolve(workspace, 'AGENTS.md'),
      targetScope: 'workspace',
      precedence,
      cwdDriftStatus
    };
  }

  if (cwd) {
    return {
      targetPath: resolve(cwd, 'AGENTS.md'),
      targetScope: 'cwd',
      precedence,
      cwdDriftStatus: 'observed_cwd_controls_projection_target'
    };
  }

  return undefined;
}

/**
 * Write AGENTS.md with claude-mem context, preserving user content outside tags.
 * Uses atomic write to prevent partial writes.
 */
export function writeAgentsMd(agentsPath: string, context: string): void {
  if (!agentsPath) return;

  // Never write inside .git directories — corrupts refs (#1165)
  const resolvedPath = resolve(agentsPath);
  if (resolvedPath.includes('/.git/') || resolvedPath.includes('\\.git\\') || resolvedPath.endsWith('/.git') || resolvedPath.endsWith('\\.git')) return;

  const dir = dirname(agentsPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  let existingContent = '';
  if (existsSync(agentsPath)) {
    existingContent = readFileSync(agentsPath, 'utf-8');
  }

  const contentBlock = [
    '# Memory Context',
    '',
    'Projection role: workspace-native context projection sink.',
    'Boundary: not storage / transcript cache / observation store; not a transcript cache, observation store, or durable database.',
    '',
    context
  ].join('\n');
  const finalContent = replaceTaggedContent(existingContent, contentBlock);
  const tempFile = `${agentsPath}.tmp`;

  try {
    writeFileSync(tempFile, finalContent);
    renameSync(tempFile, agentsPath);
  } catch (error: unknown) {
    logger.error('AGENTS_MD', 'Failed to write AGENTS.md', { agentsPath }, error instanceof Error ? error : new Error(String(error)));
  }
}
