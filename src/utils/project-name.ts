import { homedir } from 'os'
import { statSync } from 'fs';
import path from 'path';
import { logger } from './logger.js';
import { detectWorktree } from './worktree.js';

/**
 * Expand leading ~ to the user's home directory.
 * Handles "~", "~/", and "~/subpath" but not "~user/" (which is rare in cwd).
 */
function expandTilde(p: string): string {
  if (p === '~' || p.startsWith('~/')) {
    return p.replace(/^~/, homedir())
  }
  return p
}

/**
 * Find the nearest folder scope that owns the current cwd.
 *
 * A `.git` directory means a main repository root; a `.git` file means a git
 * worktree root. If no git boundary is found, the expanded cwd remains the
 * folder scope.
 */
function findNearestGitScopeRoot(expandedCwd: string): string {
  let current = path.resolve(expandedCwd);

  while (true) {
    try {
      const gitStat = statSync(path.join(current, '.git'));
      if (gitStat.isDirectory() || gitStat.isFile()) {
        return current;
      }
    } catch (error: unknown) {
      if (error instanceof Error && (error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.debug('SYSTEM', 'Unexpected error checking git scope root', { cwd: current }, error);
      }
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return path.resolve(expandedCwd);
    }
    current = parent;
  }
}

function uniqueProjects(projects: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const project of projects) {
    const normalized = project.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }

  return result;
}

/**
 * Extract project name from working directory path
 * Handles edge cases: null/undefined cwd, drive roots, trailing slashes, unexpanded ~
 *
 * @param cwd - Current working directory (absolute path, or ~-prefixed path)
 * @returns Project name or "unknown-project" if extraction fails
 */
export function getProjectName(cwd: string | null | undefined): string {
  if (!cwd || cwd.trim() === '') {
    logger.warn('SYSTEM', 'Empty cwd provided, using fallback', { cwd });
    return 'unknown-project';
  }

  // Expand leading ~ before path operations
  const expanded = expandTilde(cwd)

  // Extract basename (handles trailing slashes automatically)
  const basename = path.basename(expanded);

  // Edge case: Drive roots on Windows (C:\, J:\) or Unix root (/)
  // path.basename('C:\') returns '' (empty string)
  if (basename === '') {
    // Extract drive letter on Windows, or use 'root' on Unix
    const isWindows = process.platform === 'win32';
    if (isWindows) {
      const driveMatch = cwd.match(/^([A-Z]):\\/i);
      if (driveMatch) {
        const driveLetter = driveMatch[1].toUpperCase();
        const projectName = `drive-${driveLetter}`;
        logger.info('SYSTEM', 'Drive root detected', { cwd, projectName });
        return projectName;
      }
    }
    logger.warn('SYSTEM', 'Root directory detected, using fallback', { cwd });
    return 'unknown-project';
  }

  return basename;
}

/**
 * Project context with worktree awareness
 */
export interface ProjectContext {
  /** Canonical project name for writes/queries; `parent/worktree` when in a worktree */
  primary: string;
  /** Parent project name if in a worktree, null otherwise */
  parent: string | null;
  /** True if currently in a worktree */
  isWorktree: boolean;
  /** Projects to query for reads. In a worktree: `[parent, composite]` so
   *  main-repo context flows into every worktree while sibling worktrees stay
   *  isolated. In the main repo: `[primary]`. Writes always use `.primary`. */
  allProjects: string[];
  /** Folder scope anchor used for project shaping; nearest git root when present. */
  scopeRoot: string | null;
}

/**
 * Context shaping contract for callers that need read/query overrides.
 */
export interface ContextScope {
  /** Header and single-project query target; last read project after precedence shaping. */
  project: string;
  /** Projects to read/query, in precedence order. */
  allProjects: string[];
  /** Canonical project bucket for storage/session writes; never changed by read overrides. */
  storageProject: string;
  /** Folder scope anchor used to derive storageProject. */
  scopeRoot: string | null;
  /** Whether read scope came from explicit caller input or cwd-derived defaults. */
  source: 'cwd' | 'explicit-projects';
  /** Full cwd-derived project context for worktree/folder diagnostics. */
  context: ProjectContext;
}

/**
 * Get project context with worktree detection.
 *
 * Each worktree is its own bucket. When in a worktree, `primary` is the
 * composite `parent/worktree` (e.g. `claude-mem/dar-es-salaam`) so worktrees
 * are uniquely identified and grouped under their parent project without
 * mixing observations across them. In the main repo, `primary` is just the
 * project basename.
 *
 * @param cwd - Current working directory (absolute path)
 * @returns ProjectContext with worktree info
 */
export function getProjectContext(cwd: string | null | undefined): ProjectContext {
  const cwdProjectName = getProjectName(cwd);

  if (!cwd) {
    return { primary: cwdProjectName, parent: null, isWorktree: false, allProjects: [cwdProjectName], scopeRoot: null };
  }

  const expandedCwd = expandTilde(cwd);
  const scopeRoot = findNearestGitScopeRoot(expandedCwd);
  const scopeProjectName = getProjectName(scopeRoot);
  const worktreeInfo = detectWorktree(scopeRoot);

  if (worktreeInfo.isWorktree && worktreeInfo.parentProjectName) {
    const composite = `${worktreeInfo.parentProjectName}/${scopeProjectName}`;
    return {
      primary: composite,
      parent: worktreeInfo.parentProjectName,
      isWorktree: true,
      allProjects: [worktreeInfo.parentProjectName, composite],
      scopeRoot
    };
  }

  return { primary: scopeProjectName, parent: null, isWorktree: false, allProjects: [scopeProjectName], scopeRoot };
}

/**
 * Resolve context shaping for projection/read paths.
 *
 * `projects` is read/query precedence only. It does not rewrite the
 * cwd-derived storage bucket, so AGENTS.md remains a projection sink rather
 * than a second observation store or transcript cache.
 */
export function resolveContextScope(
  cwd: string | null | undefined,
  projects?: string[] | null
): ContextScope {
  const context = getProjectContext(cwd);
  const explicitProjects = projects ? uniqueProjects(projects) : [];
  const allProjects = explicitProjects.length > 0 ? explicitProjects : context.allProjects;
  const project = allProjects[allProjects.length - 1] ?? context.primary;

  return {
    project,
    allProjects,
    storageProject: context.primary,
    scopeRoot: context.scopeRoot ?? null,
    source: explicitProjects.length > 0 ? 'explicit-projects' : 'cwd',
    context
  };
}
